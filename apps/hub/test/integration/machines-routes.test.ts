import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/users/repo";
import { Registry } from "../../src/tunnel/registry";
import { serializeFrame, parseFrame, PROTOCOL_VERSION, type Frame } from "@mando/protocol";
import { startTestServer, type TestServer } from "../helpers/server";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);
const config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
  PUBLIC_URL: "http://localhost:8080",
});

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueTag(tag: string): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}`;
}

function uniqueEmail(tag: string): string {
  return `u${uniqueTag(tag)}@t.dev`;
}

// Registers a user directly against the repo (matching auth-routes.test.ts
// / pairing.test.ts convention -- login is the thing under test elsewhere,
// not signup) then authenticates over real HTTP via the login route, so
// this suite exercises requireUser/requireMachineOwnership the same way a
// real browser session would: with the `mando_sess` cookie the login
// response actually sets, not a session minted directly against the repo.
async function registerAndLogin(server: TestServer, tag: string): Promise<{ userId: string; cookie: string }> {
  const email = uniqueEmail(tag);
  const password = "correct-password";
  const user = await createUser(sql, email, password);

  const loginRes = await fetch(`${server.url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return { userId: user.id, cookie: setCookie.split(";")[0]! };
}

// Runs the pairing request -> approve -> poll cycle over real HTTP against
// a live `server` (as opposed to pairing.test.ts's app.request(), which
// doesn't have a listening port for the WS agent side this suite also
// needs). Mirrors pairing.test.ts's pairAndApprove helper.
async function pairAndApprove(
  server: TestServer,
  cookie: string,
  machineName: string,
): Promise<{ machineId: string; token: string }> {
  const requestRes = await fetch(`${server.url}/api/v1/pairing/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName }),
  });
  const { code } = await requestRes.json();

  const approveRes = await fetch(`${server.url}/api/v1/pairing/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  const { machineId } = await approveRes.json();

  const pollRes = await fetch(`${server.url}/api/v1/pairing/status?code=${code}`);
  const { token } = await pollRes.json();

  return { machineId, token: token as string };
}

function helloFrame(id: string, token: string): string {
  return serializeFrame({
    type: "hello",
    id,
    payload: {
      token,
      machineName: "test-machine",
      opencodePort: 4096,
      agentVersion: "0.0.1-test",
      protocolVersion: PROTOCOL_VERSION,
    },
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error before open")), { once: true });
  });
}

const FRAME_WAIT_MS = 10_000;

function waitForFrame(ws: WebSocket, predicate: (frame: Frame) => boolean, timeoutMs = FRAME_WAIT_MS): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timed out waiting for a matching frame"));
    }, timeoutMs);

    function onMessage(evt: Event) {
      const raw = (evt as MessageEvent).data;
      if (typeof raw !== "string") return;
      let frame: Frame;
      try {
        frame = parseFrame(raw);
      } catch {
        return;
      }
      if (!predicate(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frame);
    }

    ws.addEventListener("message", onMessage);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = FRAME_WAIT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// Connects a real WS agent to `server` and waits for it to register, so
// tests can make a machine show up as online through the same tunnel path
// production agents use, rather than poking the Registry directly.
async function connectAgent(server: TestServer, token: string): Promise<WebSocket> {
  const ws = new WebSocket(server.wsUrl);
  await waitForOpen(ws);
  ws.send(helloFrame(crypto.randomUUID(), token));
  await waitForFrame(ws, (f) => f.type === "registered");
  return ws;
}

test(
  "GET /api/v1/machines returns the caller's machines with correct online status",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie } = await registerAndLogin(server, "list-owner");

    const online = await pairAndApprove(server, cookie, "online-machine");
    const offline = await pairAndApprove(server, cookie, "offline-machine");

    const ws = await connectAgent(server, online.token);

    const res = await fetch(`${server.url}/api/v1/machines`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map<string, { id: string; online: boolean }>(body.machines.map((m: { id: string; online: boolean }) => [m.id, m]));

    expect(byId.get(online.machineId)?.online).toBe(true);
    expect(byId.get(offline.machineId)?.online).toBe(false);

    ws.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test("GET /api/v1/machines/:id returns the machine for its owner and 404s for a different user", async () => {
  const registry = new Registry();
  const server = await startTestServer({ sql, config, registry });
  const { cookie: ownerCookie } = await registerAndLogin(server, "get-owner");
  const { cookie: otherCookie } = await registerAndLogin(server, "get-other");

  const { machineId } = await pairAndApprove(server, ownerCookie, "get-machine");

  const ownRes = await fetch(`${server.url}/api/v1/machines/${machineId}`, { headers: { Cookie: ownerCookie } });
  expect(ownRes.status).toBe(200);
  const ownBody = await ownRes.json();
  expect(ownBody.machine.id).toBe(machineId);
  expect(ownBody.machine.online).toBe(false);

  // A different authenticated user must not be able to distinguish "not
  // mine" from "doesn't exist" -- requireMachineOwnership folds both into
  // the same 404.
  const otherRes = await fetch(`${server.url}/api/v1/machines/${machineId}`, { headers: { Cookie: otherCookie } });
  expect(otherRes.status).toBe(404);

  server.stop();
});

test(
  "POST /api/v1/machines/:id/revoke revokes the machine and closes its live tunnel",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie } = await registerAndLogin(server, "revoke-owner");

    const { machineId, token } = await pairAndApprove(server, cookie, "revoke-target");
    const ws = await connectAgent(server, token);
    expect(registry.get(machineId)).not.toBeNull();

    const closed = waitForClose(ws);

    const revokeRes = await fetch(`${server.url}/api/v1/machines/${machineId}/revoke`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(revokeRes.status).toBe(200);

    // The agent's socket must actually be closed by the revoke, not just
    // dropped from the registry -- confirms the live tunnel connection
    // itself was torn down, not merely made invisible to routes.
    await closed;
    expect(registry.get(machineId)).toBeNull();

    const statusRes = await fetch(`${server.url}/api/v1/machines/${machineId}`, { headers: { Cookie: cookie } });
    const statusBody = await statusRes.json();
    expect(statusBody.machine.online).toBe(false);

    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

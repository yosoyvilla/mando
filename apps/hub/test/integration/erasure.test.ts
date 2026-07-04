import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
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

function uniqueEmail(tag: string) {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

async function loginSessionCookie(userId: string) {
  const sessionId = await createSession(sql, userId);
  return `mando_sess=${sessionId}`;
}

// Mirrors pairing.test.ts's pairAndApprove -- runs the full request ->
// approve -> poll cycle in-process so tests get a real machine + token +
// pairing_requests row (all FK'd to the user) to verify cascade deletion
// against, rather than inserting rows by hand.
async function pairAndApprove(app: ReturnType<typeof buildApp>, cookie: string, machineName: string) {
  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName }),
  });
  const { code } = await requestRes.json();

  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  const { machineId } = await approveRes.json();

  await app.request(`/api/v1/pairing/status?code=${code}`);

  return { code, machineId };
}

test("DELETE /api/v1/me erases the caller: user + machines/tokens/sessions/pairings gone, cookie cleared, subsequent /api/v1/me is 401", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("self-erase"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const { machineId } = await pairAndApprove(app, cookie, "self-erase-machine");

  const beforeSessions = await sql`select id from user_sessions where user_id = ${owner.id}`;
  expect(beforeSessions.length).toBeGreaterThan(0);

  const res = await app.request("/api/v1/me", { method: "DELETE", headers: { Cookie: cookie } });
  expect(res.status).toBe(200);

  const setCookieHeader = res.headers.get("set-cookie");
  expect(setCookieHeader).toBeTruthy();
  expect(setCookieHeader).toContain("mando_sess=");

  const meRes = await app.request("/api/v1/me", { headers: { Cookie: cookie } });
  expect(meRes.status).toBe(401);

  expect((await sql`select id from users where id = ${owner.id}`).length).toBe(0);
  expect((await sql`select id from machines where user_id = ${owner.id}`).length).toBe(0);
  expect((await sql`select id from machine_tokens where machine_id = ${machineId}`).length).toBe(0);
  expect((await sql`select id from user_sessions where user_id = ${owner.id}`).length).toBe(0);
  expect((await sql`select code from pairing_requests where user_id = ${owner.id}`).length).toBe(0);
});

test("admin DELETE /api/v1/users/:id removes another user", async () => {
  const admin = await createUser(sql, uniqueEmail("admin-erase"), "correct-password", { isAdmin: true });
  const adminCookie = await loginSessionCookie(admin.id);
  const target = await createUser(sql, uniqueEmail("erase-target"), "correct-password");
  const app = buildApp({ sql, config });

  const res = await app.request(`/api/v1/users/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  expect(res.status).toBe(200);

  expect((await sql`select id from users where id = ${target.id}`).length).toBe(0);
});

test("non-admin DELETE /api/v1/users/:id returns 403", async () => {
  const nonAdmin = await createUser(sql, uniqueEmail("nonadmin-erase"), "correct-password");
  const nonAdminCookie = await loginSessionCookie(nonAdmin.id);
  const target = await createUser(sql, uniqueEmail("erase-target-blocked"), "correct-password");
  const app = buildApp({ sql, config });

  const res = await app.request(`/api/v1/users/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: nonAdminCookie },
  });
  expect(res.status).toBe(403);

  expect((await sql`select id from users where id = ${target.id}`).length).toBe(1);
});

test("admin DELETE /api/v1/users/:id for an unknown id returns 404", async () => {
  const admin = await createUser(sql, uniqueEmail("admin-erase-404"), "correct-password", { isAdmin: true });
  const adminCookie = await loginSessionCookie(admin.id);
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/users/00000000-0000-0000-0000-000000000000", {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  expect(res.status).toBe(404);
});

// --- Live tunnel close on erasure -- needs a real listening server + a
// real WebSocket agent connection, so this one test uses startTestServer
// (as machines-routes.test.ts does for the equivalent revoke case) instead
// of buildApp's app.request().

function helloFrame(id: string, token: string): string {
  return serializeFrame({
    type: "hello",
    id,
    payload: {
      token,
      machineName: "erase-test-machine",
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

async function connectAgent(server: TestServer, token: string): Promise<WebSocket> {
  const ws = new WebSocket(server.wsUrl);
  await waitForOpen(ws);
  ws.send(helloFrame(crypto.randomUUID(), token));
  await waitForFrame(ws, (f) => f.type === "registered");
  return ws;
}

test(
  "self-erasure with a live tunnel closes it (registry no longer holds the connection)",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });

    const email = uniqueEmail("erase-live-tunnel");
    const password = "correct-password";
    const owner = await createUser(sql, email, password);
    const loginRes = await fetch(`${server.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

    const requestRes = await fetch(`${server.url}/api/v1/pairing/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineName: "live-tunnel-machine" }),
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

    const ws = await connectAgent(server, token);
    expect(registry.get(machineId)).not.toBeNull();

    const closed = waitForClose(ws);

    const deleteRes = await fetch(`${server.url}/api/v1/me`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(deleteRes.status).toBe(200);

    await closed;
    expect(registry.get(machineId)).toBeNull();
    expect((await sql`select id from users where id = ${owner.id}`).length).toBe(0);

    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

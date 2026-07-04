import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/users/repo";
import { createMachine, insertMachineToken } from "../../src/machines/repo";
import { hashSecret } from "../../src/auth/password";
import { serializeFrame, parseFrame, type Frame } from "@mando/protocol";
import { Registry } from "../../src/tunnel/registry";
import { startTestServer } from "../helpers/server";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);
const config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret",
  PUBLIC_URL: "http://localhost:8080",
});

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueTag(tag: string): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}`;
}

// Seeds a machine + plaintext token directly against the repo layer,
// bypassing the pairing HTTP flow -- this test only cares about what
// happens once an agent presents a token over the tunnel socket, not how
// the token was minted (that's pairing.test.ts's job).
async function seedMachine(tag: string) {
  const unique = uniqueTag(tag);
  const owner = await createUser(sql, `u${unique}@t.dev`, "correct-password");
  const machine = await createMachine(sql, { userId: owner.id, name: `${unique}-machine` });
  const token = `tok_${unique}`;
  await insertMachineToken(sql, { machineId: machine.id, tokenHash: await hashSecret(token) });
  return { machine, token };
}

function helloFrame(id: string, token: string): string {
  return serializeFrame({
    type: "hello",
    id,
    payload: { token, machineName: "test-machine", opencodePort: 4096, agentVersion: "0.0.1-test" },
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error before open")), { once: true });
  });
}

// findMachineByToken scans every non-revoked token and runs a full argon2
// verify against each one (see machines/repo.ts) -- on this suite's shared,
// long-lived, never-truncated test DB (a deliberate convention, see
// auth-routes.test.ts) that scan has been observed to take several
// seconds once enough tokens accumulate across a long dev session. These
// waits are sized generously so hello-frame round trips survive that,
// rather than to allow for anything slow in the tunnel code itself.
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

test(
  "hello with a valid token registers the connection and replies registered",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("valid-hello");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-1", token));

    const registered = await waitForFrame(ws, (f) => f.type === "registered");
    expect(registered.type).toBe("registered");
    if (registered.type === "registered") {
      expect(registered.payload.machineId).toBe(machine.id);
    }
    expect(registry.get(machine.id)).not.toBeNull();

    ws.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "hello with an invalid token gets an unauthorized error and the socket closes",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-2", "not-a-real-token"));

    const errorFrame = await waitForFrame(ws, (f) => f.type === "error");
    expect(errorFrame.type).toBe("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload.code).toBe("unauthorized");
    }

    await waitForClose(ws);
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test("a machine that never connects has no registry entry", async () => {
  const registry = new Registry();
  const server = await startTestServer({ sql, config, registry });
  const { machine } = await seedMachine("never-connected");

  expect(registry.get(machine.id)).toBeNull();

  server.stop();
});

test(
  "missed pings close the connection and remove it from the registry",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry, tunnelPingIntervalMs: 30 });
    const { machine, token } = await seedMachine("ping-timeout");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-3", token));
    await waitForFrame(ws, (f) => f.type === "registered");
    expect(registry.get(machine.id)).not.toBeNull();

    // Never reply with pong -- after 2 missed pings (2 * 30ms) the hub
    // should close the socket and drop the machine from the registry.
    await waitForClose(ws, 3000);
    expect(registry.get(machine.id)).toBeNull();

    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "replying pong keeps the connection registered past a ping cycle",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry, tunnelPingIntervalMs: 30 });
    const { machine, token } = await seedMachine("ping-pong");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-4", token));
    await waitForFrame(ws, (f) => f.type === "registered");

    ws.addEventListener("message", (evt) => {
      const raw = (evt as MessageEvent).data;
      if (typeof raw !== "string") return;
      try {
        const frame = parseFrame(raw);
        if (frame.type === "ping") ws.send(serializeFrame({ type: "pong", id: frame.id }));
      } catch {
        // ignore
      }
    });

    // Survive several ping cycles by always answering with pong.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(registry.get(machine.id)).not.toBeNull();

    ws.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "a malformed frame does not crash the connection",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("malformed-frame");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send("not json at all");
    ws.send(helloFrame("hello-5", token));

    const registered = await waitForFrame(ws, (f) => f.type === "registered");
    expect(registered.type).toBe("registered");
    expect(registry.get(machine.id)).not.toBeNull();

    ws.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

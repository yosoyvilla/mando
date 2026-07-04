import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/users/repo";
import { createMachine, insertMachineToken } from "../../src/machines/repo";
import { hashSecret } from "../../src/auth/password";
import { serializeFrame, parseFrame, PROTOCOL_VERSION, type Frame } from "@mando/protocol";
import { Registry } from "../../src/tunnel/registry";
import { startTestServer } from "../helpers/server";

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

// Seeds a machine + plaintext token directly against the repo layer,
// bypassing the pairing HTTP flow -- this test only cares about what
// happens once an agent presents a token over the tunnel socket, not how
// the token was minted (that's pairing.test.ts's job). The plaintext
// token mirrors the `<tokenId>.<secret>` composite that approvePairing
// hands out (see machines/repo.ts findMachineByToken).
async function seedMachine(tag: string) {
  const unique = uniqueTag(tag);
  const owner = await createUser(sql, `u${unique}@t.dev`, "correct-password");
  const machine = await createMachine(sql, { userId: owner.id, name: `${unique}-machine` });
  const secret = `tok_${unique}`;
  const tokenId = await insertMachineToken(sql, { machineId: machine.id, tokenHash: await hashSecret(secret) });
  const token = `${tokenId}.${secret}`;
  return { machine, token };
}

// Defaults to the hub's own PROTOCOL_VERSION so every existing test below
// (written before version negotiation existed) keeps sending a
// compatible hello without having to know about it. Tests exercising
// version_mismatch pass `protocolVersion` explicitly, or `null` to
// simulate a pre-versioning agent build that omits the field entirely --
// NOT `undefined`, since a default parameter substitutes its default for
// an explicitly-passed `undefined` too, which would silently defeat the
// "omit the field" case.
function helloFrame(id: string, token: string, protocolVersion?: number | null): string {
  const version = protocolVersion === null ? undefined : protocolVersion ?? PROTOCOL_VERSION;
  return serializeFrame({
    type: "hello",
    id,
    payload: {
      token,
      machineName: "test-machine",
      opencodePort: 4096,
      agentVersion: "0.0.1-test",
      ...(version === undefined ? {} : { protocolVersion: version }),
    },
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error before open")), { once: true });
  });
}

// findMachineByToken looks up the presented token's id directly (an
// indexed PK lookup) and runs exactly one argon2 verify against that row
// (see machines/repo.ts) -- it no longer scans every live token, so it
// stays fast regardless of how many tokens have accumulated in this
// suite's shared, long-lived, never-truncated test DB (a deliberate
// convention, see auth-routes.test.ts). These waits are kept generous
// for general CI/network slack, not to tolerate a slow lookup.
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

test(
  "hello with a matching protocolVersion registers OK",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("version-match");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-vmatch", token, PROTOCOL_VERSION));

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
  "hello with a mismatched major protocolVersion gets version_mismatch, closes, and is not registered",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("version-mismatch");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-vmismatch", token, PROTOCOL_VERSION + 1));

    const errorFrame = await waitForFrame(ws, (f) => f.type === "error");
    expect(errorFrame.type).toBe("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload.code).toBe("version_mismatch");
    }

    await waitForClose(ws);
    expect(registry.get(machine.id)).toBeNull();

    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "hello with no protocolVersion (pre-versioning agent) gets version_mismatch, not a silent timeout",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("version-missing");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);
    ws.send(helloFrame("hello-vmissing", token, null));

    const errorFrame = await waitForFrame(ws, (f) => f.type === "error");
    expect(errorFrame.type).toBe("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload.code).toBe("version_mismatch");
    }

    await waitForClose(ws);
    expect(registry.get(machine.id)).toBeNull();

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
  "two hello frames sent back-to-back only register once and leak no timer",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machine, token } = await seedMachine("duplicate-hello");

    const ws = new WebSocket(server.wsUrl);
    await waitForOpen(ws);

    const registeredFrames: Frame[] = [];
    ws.addEventListener("message", (evt) => {
      const raw = (evt as MessageEvent).data;
      if (typeof raw !== "string") return;
      try {
        const frame = parseFrame(raw);
        if (frame.type === "registered") registeredFrames.push(frame);
      } catch {
        // ignore
      }
    });

    // Send both hellos before the first one's findMachineByToken await
    // (a real DB round trip) can resolve, reproducing the race that used
    // to let a second `handleHello` run and overwrite (leak) the first
    // pingTimer -- see ws.ts's helloInProgress guard.
    ws.send(helloFrame("hello-dup-1", token));
    ws.send(helloFrame("hello-dup-2", token));

    await waitForFrame(ws, (f) => f.type === "registered");
    // Give a wrongly-processed second hello time to also register, if the
    // guard were missing.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(registeredFrames.length).toBe(1);
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

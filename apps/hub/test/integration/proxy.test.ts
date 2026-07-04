import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/users/repo";
import { Registry } from "../../src/tunnel/registry";
import { serializeFrame, parseFrame, type Frame } from "@mando/protocol";
import { startTestServer, type TestServer } from "../helpers/server";

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

function uniqueEmail(tag: string): string {
  return `u${uniqueTag(tag)}@t.dev`;
}

// Mirrors machines-routes.test.ts: authenticate over real HTTP so this
// suite exercises requireUser the same way a browser would.
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
    payload: { token, machineName: "test-machine", opencodePort: 4096, agentVersion: "0.0.1-test" },
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

// Connects a real WS agent and waits for it to register. This doubles as
// our "fake agent" -- rather than running a real opencode server, the
// test drives this socket directly to answer http_request frames the way
// a real agent's tunnel client would, so the proxy is exercised through
// exactly the same Conn/Registry path production traffic uses.
async function connectAgent(server: TestServer, token: string): Promise<WebSocket> {
  const ws = new WebSocket(server.wsUrl);
  await waitForOpen(ws);
  ws.send(helloFrame(crypto.randomUUID(), token));
  await waitForFrame(ws, (f) => f.type === "registered");
  return ws;
}

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

// Fake-agent helper: replies to a single http_request frame for `path`
// with response_begin(status) + one response_chunk per entry in `chunks`
// + (optionally) response_end. Each chunk is sent as its own frame/message
// rather than batched, matching how a real agent streams SSE bytes as
// they're produced.
function respondTo(
  ws: WebSocket,
  path: string,
  opts: { status: number; chunks: string[]; end: boolean },
): void {
  function onMessage(evt: Event) {
    const raw = (evt as MessageEvent).data;
    if (typeof raw !== "string") return;
    let frame: Frame;
    try {
      frame = parseFrame(raw);
    } catch {
      return;
    }
    if (frame.type !== "http_request" || frame.payload.path !== path) return;
    ws.removeEventListener("message", onMessage);

    const id = frame.id;
    ws.send(serializeFrame({ type: "response_begin", id, payload: { status: opts.status, headers: {} } }));
    void (async () => {
      for (const chunk of opts.chunks) {
        // A real agent streaming SSE bytes as they're produced never sends
        // them all in one synchronous burst -- each chunk is its own
        // network write, separated by however long the underlying process
        // took to produce it. Yielding here (a fixed short delay, not
        // asserted on -- see the test's own comment about avoiding
        // wall-clock assertions) reproduces that: without it, Node/Bun
        // coalesce back-to-back synchronous enqueues from one task into a
        // single flush, which would defeat the point of this test (proving
        // chunks arrive incrementally and in order, not merged/batched).
        await new Promise((resolve) => setTimeout(resolve, 15));
        ws.send(serializeFrame({ type: "response_chunk", id, payload: { data: b64(chunk) } }));
      }
      if (opts.end) {
        ws.send(serializeFrame({ type: "response_end", id, payload: {} }));
      }
    })();
  }
  ws.addEventListener("message", onMessage);
}

// Captures every `cancel` frame the fake agent receives, keyed by the
// http_request id it was sent for (learned from the preceding
// http_request frame on the same path).
function watchForCancel(ws: WebSocket, path: string): { idPromise: Promise<string>; cancelPromise: Promise<Frame> } {
  let requestId: string | null = null;
  let resolveId: (id: string) => void;
  const idPromise = new Promise<string>((resolve) => {
    resolveId = resolve;
  });

  const cancelPromise = new Promise<Frame>((resolve) => {
    ws.addEventListener("message", (evt) => {
      const raw = (evt as MessageEvent).data;
      if (typeof raw !== "string") return;
      let frame: Frame;
      try {
        frame = parseFrame(raw);
      } catch {
        return;
      }
      if (frame.type === "http_request" && frame.payload.path === path) {
        requestId = frame.id;
        resolveId(frame.id);
      }
      if (frame.type === "cancel" && frame.id === requestId) {
        resolve(frame);
      }
    });
  });

  return { idPromise, cancelPromise };
}

async function setUpOnlineMachine(
  server: TestServer,
  tag: string,
): Promise<{ cookie: string; machineId: string; agentWs: WebSocket }> {
  const { cookie } = await registerAndLogin(server, tag);
  const { machineId, token } = await pairAndApprove(server, cookie, `${tag}-machine`);
  const agentWs = await connectAgent(server, token);
  return { cookie, machineId, agentWs };
}

test(
  "GET .../opencode/ping proxies to the agent and returns its response body",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie, machineId, agentWs } = await setUpOnlineMachine(server, "ping");

    respondTo(agentWs, "/ping", { status: 200, chunks: ["pong"], end: true });

    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/ping`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");

    agentWs.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "GET .../opencode/sse streams chunks incrementally in order",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie, machineId, agentWs } = await setUpOnlineMachine(server, "sse");

    // No response_end -- the stream is kept open (as a real SSE response
    // would be) until the client cancels; this test only reads three
    // chunks and never waits on wall-clock gaps between them.
    respondTo(agentWs, "/sse", { status: 200, chunks: ["a", "b", "c"], end: false });

    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/sse`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();

    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!).toString("utf8")).toBe("a");
    expect(second.done).toBe(false);
    expect(Buffer.from(second.value!).toString("utf8")).toBe("b");
    expect(third.done).toBe(false);
    expect(Buffer.from(third.value!).toString("utf8")).toBe("c");

    await reader.cancel();
    agentWs.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

test(
  "unauthenticated request to the proxy route returns 401",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie } = await registerAndLogin(server, "unauth");
    const { machineId } = await pairAndApprove(server, cookie, "unauth-machine");

    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/ping`);
    expect(res.status).toBe(401);

    server.stop();
  },
  FRAME_WAIT_MS,
);

test(
  "a different authenticated user's request to someone else's machine returns 404 and never reaches the agent",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { machineId, agentWs } = await setUpOnlineMachine(server, "cross-tenant-owner");
    const { cookie: otherCookie } = await registerAndLogin(server, "cross-tenant-other");

    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/ping`, {
      headers: { Cookie: otherCookie },
    });
    // requireMachineOwnership folds "not yours" and "doesn't exist" into
    // the same 404 (pre-existing behavior, mirrored by
    // machines-routes.test.ts) -- a cross-tenant caller must not be able
    // to distinguish the two.
    expect(res.status).toBe(404);

    // The request must be rejected by requireUser/requireMachineOwnership
    // before proxyRequest ever runs, so the owner's agent should never see
    // an http_request frame for this path. A short timeout is fine here:
    // this asserts absence, not timing -- if the frame were going to
    // arrive it would do so almost immediately (no network hop beyond the
    // local test WebSocket).
    await expect(
      waitForFrame(agentWs, (f) => f.type === "http_request" && f.payload.path === "/ping", 300),
    ).rejects.toThrow(/timed out waiting/);

    agentWs.close();
    server.stop();
  },
  FRAME_WAIT_MS,
);

test(
  "offline machine returns 503 machine_offline",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie } = await registerAndLogin(server, "offline");
    const { machineId } = await pairAndApprove(server, cookie, "offline-machine");
    // Deliberately never connect an agent for this machine.

    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/ping`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "machine_offline" });

    server.stop();
  },
  FRAME_WAIT_MS,
);

test(
  "cancelling the browser's read sends a cancel frame to the agent for that request id",
  async () => {
    const registry = new Registry();
    const server = await startTestServer({ sql, config, registry });
    const { cookie, machineId, agentWs } = await setUpOnlineMachine(server, "cancel");

    const { idPromise, cancelPromise } = watchForCancel(agentWs, "/sse");
    respondTo(agentWs, "/sse", { status: 200, chunks: ["a", "b", "c"], end: false });

    // Simulate a real client disconnect (tab closed, navigation away) via
    // AbortController rather than just reader.cancel() -- aborting the
    // fetch itself tears down the underlying connection immediately, which
    // is what actually triggers the Response stream's cancel() callback
    // promptly. Plain reader.cancel() on a stream with data still
    // in-flight leaves the HTTP/1.1 keep-alive socket parked in Bun's
    // connection pool, only reclaimed by its ~10s idle timeout -- a
    // real-world non-issue (Bun eventually reclaims it) but an
    // unnecessary multi-second tax on every run of this test.
    const abortController = new AbortController();
    const res = await fetch(`${server.url}/api/v1/machines/${machineId}/opencode/sse`, {
      headers: { Cookie: cookie },
      signal: abortController.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    await reader.read(); // make sure the stream has actually started
    const requestId = await idPromise;

    abortController.abort();

    const cancelFrame = await cancelPromise;
    expect(cancelFrame.type).toBe("cancel");
    expect(cancelFrame.id).toBe(requestId);

    agentWs.close();
    server.stop();
  },
  FRAME_WAIT_MS * 2,
);

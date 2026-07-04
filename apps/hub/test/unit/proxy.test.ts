import { test, expect } from "bun:test";
import type { Frame } from "@mando/protocol";
import type { Conn } from "../../src/tunnel/registry";
import { proxyRequest } from "../../src/tunnel/proxy";

// A controllable fake Conn: captures every frame sent to the "agent" and
// lets the test drive response_* frames back into whatever handler
// proxyRequest registered, without needing a real WebSocket/Registry.
function fakeConn(): {
  conn: Conn;
  sent: Frame[];
  offResponseCalls: string[];
  deliver(frame: Frame): void;
} {
  const sent: Frame[] = [];
  const offResponseCalls: string[] = [];
  let handler: ((frame: Frame) => void) | null = null;

  const conn: Conn = {
    send(frame) {
      sent.push(frame);
    },
    onResponse(_id, h) {
      handler = h;
    },
    offResponse(id) {
      offResponseCalls.push(id);
      handler = null;
    },
    close() {},
  };

  return {
    conn,
    sent,
    offResponseCalls,
    deliver(frame) {
      handler?.(frame);
    },
  };
}

function requestId(sent: Frame[]): string {
  const req = sent.find((f) => f.type === "http_request");
  if (!req) throw new Error("no http_request frame was sent");
  return req.id;
}

test("assembles response_begin + response_chunk* + response_end into a streamed Response", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/ping", headers: {}, body: null });
  const id = requestId(sent);

  deliver({ type: "response_begin", id, payload: { status: 200, headers: { "x-test": "1" } } });
  const res = await resPromise;
  expect(res.status).toBe(200);
  expect(res.headers.get("x-test")).toBe("1");

  deliver({ type: "response_chunk", id, payload: { data: Buffer.from("po").toString("base64") } });
  deliver({ type: "response_chunk", id, payload: { data: Buffer.from("ng").toString("base64") } });
  deliver({ type: "response_end", id, payload: {} });

  expect(await res.text()).toBe("pong");
});

test("strips hop-by-hop/length headers from the agent's response before forwarding to the browser", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/ping", headers: {}, body: null });
  const id = requestId(sent);

  // A stale content-length (computed against the agent's own body, not
  // this stream's re-chunked bytes) or hop-by-hop connection/framing
  // headers must never reach the browser -- see the module comment above
  // filterResponseHeaders in proxy.ts.
  deliver({
    type: "response_begin",
    id,
    payload: {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "Content-Length": "999",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
      },
    },
  });
  const res = await resPromise;

  expect(res.headers.get("content-type")).toBe("text/plain");
  expect(res.headers.has("content-length")).toBe(false);
  expect(res.headers.has("transfer-encoding")).toBe(false);
  expect(res.headers.has("connection")).toBe(false);

  deliver({ type: "response_end", id, payload: {} });
  await res.text();
});

test("adds X-Content-Type-Options: nosniff to the streamed response, even if the agent didn't send one", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/ping", headers: {}, body: null });
  const id = requestId(sent);

  deliver({ type: "response_begin", id, payload: { status: 200, headers: { "content-type": "text/plain" } } });
  const res = await resPromise;

  expect(res.headers.get("x-content-type-options")).toBe("nosniff");

  deliver({ type: "response_end", id, payload: {} });
  await res.text();
});

test("does not duplicate the header if the agent already sent its own X-Content-Type-Options", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/ping", headers: {}, body: null });
  const id = requestId(sent);

  deliver({
    type: "response_begin",
    id,
    payload: { status: 200, headers: { "X-Content-Type-Options": "sniff-me-anyway" } },
  });
  const res = await resPromise;

  expect(res.headers.get("x-content-type-options")).toBe("nosniff");

  deliver({ type: "response_end", id, payload: {} });
  await res.text();
});

test("a response_error before response_begin resolves as a 502, never as a hung promise", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/boom", headers: {}, body: null });
  const id = requestId(sent);

  deliver({ type: "response_error", id, payload: { code: "agent_error", message: "opencode unreachable" } });

  const res = await resPromise;
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "agent_error", message: "opencode unreachable" });
});

test("a response_error after response_begin errors the stream instead of resolving a new Response", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/mid-stream-error", headers: {}, body: null });
  const id = requestId(sent);

  deliver({ type: "response_begin", id, payload: { status: 200, headers: {} } });
  const res = await resPromise;
  const reader = res.body!.getReader();
  const pendingRead = reader.read();

  // ReadableStreamDefaultController.error() discards the queue and rejects
  // any in-flight read with the error -- there is no "drain what already
  // arrived, then fail" step, matching the Streams spec.
  deliver({ type: "response_error", id, payload: { code: "agent_error", message: "stream died" } });

  await expect(pendingRead).rejects.toThrow(/stream died/);
});

test("a response_begin with an out-of-range status (bypassing schema validation) resolves as a 502 instead of throwing", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/weird-status", headers: {}, body: null });
  const id = requestId(sent);

  // frames.ts's schema now rejects this before it ever reaches here (see
  // packages/protocol/test/frames.test.ts), but proxy.ts must defend
  // itself too -- `new Response(stream, { status })` throws a RangeError
  // for anything outside 200-599, and that must never escape this
  // onResponse handler and hang the request.
  deliver({ type: "response_begin", id, payload: { status: 999, headers: {} } });

  const res = await resPromise;
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(body.error).toBe("invalid_status");
});

test("times out with 504 if response_begin never arrives within timeoutMs", async () => {
  const { conn } = fakeConn();

  const res = await proxyRequest(conn, { method: "GET", path: "/slow", headers: {}, body: null }, { timeoutMs: 20 });

  expect(res.status).toBe(504);
  const body = await res.json();
  expect(body.error).toBe("proxy_timeout");
});

test("the timeout never fires once response_begin has arrived, however long the stream stays open", async () => {
  const { conn, sent, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/sse", headers: {}, body: null }, { timeoutMs: 20 });
  const id = requestId(sent);

  deliver({ type: "response_begin", id, payload: { status: 200, headers: {} } });
  const res = await resPromise;
  expect(res.status).toBe(200);

  // Outlive the 20ms timeout window with the stream still open -- if the
  // timeout weren't cleared on response_begin, this stream would error.
  await new Promise((resolve) => setTimeout(resolve, 60));

  deliver({ type: "response_chunk", id, payload: { data: Buffer.from("still alive").toString("base64") } });
  deliver({ type: "response_end", id, payload: {} });

  expect(await res.text()).toBe("still alive");
});

test("cancelling the response stream sends a cancel frame and releases the handler", async () => {
  const { conn, sent, offResponseCalls, deliver } = fakeConn();

  const resPromise = proxyRequest(conn, { method: "GET", path: "/sse", headers: {}, body: null });
  const id = requestId(sent);

  deliver({ type: "response_begin", id, payload: { status: 200, headers: {} } });
  const res = await resPromise;

  await res.body!.cancel();

  const cancelFrame = sent.find((f) => f.type === "cancel");
  expect(cancelFrame?.id).toBe(id);
  expect(offResponseCalls).toContain(id);
});

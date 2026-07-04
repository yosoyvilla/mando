import { describe, it, expect, afterEach } from "bun:test";
import type { Frame } from "@mando/protocol";
import { forward } from "../../src/forward";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function startStub(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

function decodeChunks(sent: Frame[]): string {
  return sent
    .filter((f) => f.type === "response_chunk")
    .map((f) => Buffer.from((f as { payload: { data: string } }).payload.data, "base64").toString())
    .join("");
}

describe("forward", () => {
  it("streams a simple response as begin + chunk('pong') + end", async () => {
    const localBase = startStub((req) => {
      if (new URL(req.url).pathname === "/ping") {
        return new Response("pong", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-1",
      payload: { method: "GET", path: "/ping", headers: {}, body: null },
    };

    const sent: Frame[] = [];
    await forward(frame, localBase, (f) => sent.push(f));

    expect(sent[0]).toMatchObject({ type: "response_begin", id: "req-1", payload: { status: 200 } });
    expect(decodeChunks(sent)).toBe("pong");
    expect(sent[sent.length - 1]).toMatchObject({ type: "response_end", id: "req-1", payload: {} });
  });

  it("adds a Basic auth header when opencodePassword is set", async () => {
    // Captured via an object property (not a bare `let`) so TS doesn't
    // narrow the value to `null` at the read below -- the fetch handler
    // runs asynchronously, invisibly to TS's control-flow analysis.
    const captured: { auth: string | null } = { auth: null };
    const localBase = startStub((req) => {
      captured.auth = req.headers.get("authorization");
      return new Response("ok", { status: 200 });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-auth",
      payload: { method: "GET", path: "/ping", headers: {}, body: null },
    };

    const sent: Frame[] = [];
    await forward(frame, localBase, (f) => sent.push(f), { opencodePassword: "secret" });

    const expected = `Basic ${Buffer.from("opencode:secret").toString("base64")}`;
    expect(captured.auth).toBe(expected);
    expect(sent[0]).toMatchObject({ type: "response_begin", payload: { status: 200 } });
  });

  it("forwards method/path/headers/body to the local server", async () => {
    const captured: { method: string; header: string | null; body: string } = {
      method: "",
      header: null,
      body: "",
    };
    const localBase = startStub(async (req) => {
      captured.method = req.method;
      captured.header = req.headers.get("x-custom");
      captured.body = await req.text();
      return new Response("created", { status: 201 });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-2",
      payload: {
        method: "POST",
        path: "/echo",
        headers: { "x-custom": "hello" },
        body: Buffer.from("payload-body").toString("base64"),
      },
    };

    const sent: Frame[] = [];
    await forward(frame, localBase, (f) => sent.push(f));

    expect(captured.method).toBe("POST");
    expect(captured.header).toBe("hello");
    expect(captured.body).toBe("payload-body");
    expect(sent[0]).toMatchObject({ type: "response_begin", payload: { status: 201 } });
  });

  it("aborts before response_begin: emits a cancelled response_error and nothing else", async () => {
    const localBase = startStub(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response("too-late", { status: 200 });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-abort-early",
      payload: { method: "GET", path: "/slow-early", headers: {}, body: null },
    };

    const controller = new AbortController();
    const sent: Frame[] = [];
    const pending = forward(frame, localBase, (f) => sent.push(f), { signal: controller.signal });
    controller.abort();
    await pending;

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "response_error",
      id: "req-abort-early",
      payload: { code: "cancelled" },
    });
  });

  it("aborts mid-stream: stops emitting chunks and ends with a cancelled response_error", async () => {
    const localBase = startStub(() => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk1\n"));
          await new Promise((r) => setTimeout(r, 200));
          // Never reached once the consumer aborts first -- proves forward
          // stopped reading rather than draining the whole stream.
          controller.enqueue(new TextEncoder().encode("chunk2\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-abort-mid",
      payload: { method: "GET", path: "/slow-mid", headers: {}, body: null },
    };

    const controller = new AbortController();
    const sent: Frame[] = [];
    const pending = forward(frame, localBase, (f) => sent.push(f), { signal: controller.signal });

    // Let response_begin (and likely chunk1) land, then abort well before
    // the 200ms delay releases chunk2.
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await pending;

    expect(sent[0]).toMatchObject({ type: "response_begin", id: "req-abort-mid" });
    expect(decodeChunks(sent)).not.toContain("chunk2");
    expect(sent[sent.length - 1]).toMatchObject({
      type: "response_error",
      id: "req-abort-mid",
      payload: { code: "cancelled" },
    });
  });

  it("strips content-encoding (and content-range) from the emitted response_begin, since Bun's fetch already decompressed the body", async () => {
    const gzipped = Bun.gzipSync(Buffer.from("gzipped-body"));
    const localBase = startStub(() => {
      return new Response(gzipped, {
        status: 200,
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
      });
    });

    const frame = {
      type: "http_request" as const,
      id: "req-gzip",
      payload: { method: "GET", path: "/gzip", headers: {}, body: null },
    };

    const sent: Frame[] = [];
    await forward(frame, localBase, (f) => sent.push(f));

    const begin = sent[0] as Extract<Frame, { type: "response_begin" }>;
    expect(begin.type).toBe("response_begin");
    expect(begin.payload.headers["content-encoding"]).toBeUndefined();
    expect(begin.payload.headers["content-type"]).toBe("text/plain");
    // Bun's fetch decompresses transparently -- the bytes forwarded as
    // response_chunk frames are the original plaintext, not gzip bytes.
    expect(decodeChunks(sent)).toBe("gzipped-body");
  });

  it("emits response_error when the local fetch fails (connection refused)", async () => {
    // Start and immediately stop a server to get a port guaranteed to be
    // free/closed, so the fetch below fails with a connection error.
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const localBase = `http://127.0.0.1:${s.port}`;
    s.stop(true);

    const frame = {
      type: "http_request" as const,
      id: "req-3",
      payload: { method: "GET", path: "/ping", headers: {}, body: null },
    };

    const sent: Frame[] = [];
    await forward(frame, localBase, (f) => sent.push(f));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "response_error", id: "req-3", payload: { code: "fetch_failed" } });
  });

  // SSRF guard: `path` comes from the hub, which is supposed to always send
  // a leading-"/" path confined to this machine's own opencode server (see
  // apps/hub/src/proxy/routes.ts). These tests prove forward() enforces
  // that itself -- as defense in depth, independent of whatever the hub
  // does -- rather than trusting the frame's `path` and string-concatenating
  // it onto `localBase` for fetch(). A stub with a hit counter proves the
  // rejected cases never reach the local server at all (so no request --
  // and no Authorization header -- is ever sent to a non-local origin).
  describe("SSRF guard", () => {
    function stubWithHitCounter(): { localBase: string; hits: { count: number } } {
      const hits = { count: 0 };
      const localBase = startStub(() => {
        hits.count += 1;
        return new Response("ok", { status: 200 });
      });
      return { localBase, hits };
    }

    const maliciousPaths = ["@evil.com/x", "//evil.com/x", "http://evil.com", "not-even-a-path"];

    for (const path of maliciousPaths) {
      it(`rejects a path that would escape localBase's origin: ${JSON.stringify(path)}`, async () => {
        const { localBase, hits } = stubWithHitCounter();
        const frame = {
          type: "http_request" as const,
          id: "req-ssrf",
          payload: { method: "GET", path, headers: {}, body: null },
        };

        const sent: Frame[] = [];
        await forward(frame, localBase, (f) => sent.push(f), { opencodePassword: "secret" });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          type: "response_error",
          id: "req-ssrf",
          payload: { code: "fetch_failed", message: "invalid path" },
        });
        expect(hits.count).toBe(0);
      });
    }

    it("still serves a normal '/'-prefixed path unaffected by the guard", async () => {
      const { localBase, hits } = stubWithHitCounter();
      const frame = {
        type: "http_request" as const,
        id: "req-ssrf-ok",
        payload: { method: "GET", path: "/session", headers: {}, body: null },
      };

      const sent: Frame[] = [];
      await forward(frame, localBase, (f) => sent.push(f));

      expect(hits.count).toBe(1);
      expect(sent[0]).toMatchObject({ type: "response_begin", id: "req-ssrf-ok", payload: { status: 200 } });
      expect(sent[sent.length - 1]).toMatchObject({ type: "response_end", id: "req-ssrf-ok" });
    });

    it("fails closed (never follows) if the local opencode server itself responds with a redirect", async () => {
      // Even a request that passed the origin check must not let the local
      // server bounce it elsewhere -- a redirect to an attacker-controlled
      // Location would otherwise carry the Authorization header set below
      // right along with it.
      const localBase = startStub(() => Response.redirect("http://evil.com/steal", 302));

      const frame = {
        type: "http_request" as const,
        id: "req-redirect",
        payload: { method: "GET", path: "/redirecting", headers: {}, body: null },
      };

      const sent: Frame[] = [];
      await forward(frame, localBase, (f) => sent.push(f), { opencodePassword: "secret" });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "response_error", id: "req-redirect", payload: { code: "fetch_failed" } });
    });
  });
});

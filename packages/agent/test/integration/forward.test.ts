import { describe, it, expect, afterEach } from "bun:test";
import type { Frame } from "@mando/protocol";
import { forward } from "../../src/forward";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

// This suite exercises forward() against a stub server that streams its
// body in separate writes with delays in between (mimicking an SSE
// response from opencode). It proves forward relays chunks incrementally
// via response.body.getReader() rather than buffering the whole response
// before emitting any response_chunk frames.
describe("forward (SSE-style streaming)", () => {
  it("relays each write as its own response_chunk, incrementally", async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname !== "/sse") return new Response("not found", { status: 404 });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
            await new Promise((r) => setTimeout(r, 15));
            controller.enqueue(new TextEncoder().encode("chunk2\n"));
            await new Promise((r) => setTimeout(r, 15));
            controller.enqueue(new TextEncoder().encode("chunk3\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const localBase = `http://127.0.0.1:${server.port}`;

    const frame = {
      type: "http_request" as const,
      id: "sse-1",
      payload: { method: "GET", path: "/sse", headers: {}, body: null },
    };

    const sent: Frame[] = [];
    const chunkTimestamps: number[] = [];
    await forward(frame, localBase, (f) => {
      if (f.type === "response_chunk") chunkTimestamps.push(Date.now());
      sent.push(f);
    });

    expect(sent[0]?.type).toBe("response_begin");
    const chunkFrames = sent.filter((f) => f.type === "response_chunk");
    expect(chunkFrames.length).toBeGreaterThanOrEqual(2);

    const combined = chunkFrames
      .map((f) => Buffer.from((f as { payload: { data: string } }).payload.data, "base64").toString())
      .join("");
    expect(combined).toBe("chunk1\nchunk2\nchunk3\n");
    expect(sent[sent.length - 1]).toMatchObject({ type: "response_end", id: "sse-1", payload: {} });

    // The 30ms of injected delay between writes must show up as a gap
    // between when the first and last chunk frames were emitted -- if
    // forward() buffered the whole body first, all chunk frames would be
    // emitted back-to-back after the full ~30ms wait, not spread across it.
    const spread = chunkTimestamps[chunkTimestamps.length - 1]! - chunkTimestamps[0]!;
    expect(spread).toBeGreaterThanOrEqual(15);
  });
});

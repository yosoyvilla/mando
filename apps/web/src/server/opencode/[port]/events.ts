import { defineHandler } from "nitro/h3";
import { getOpencodeClient } from "../../lib/opencode-client";
import { parsePort } from "../../lib/validation";

const encoder = new TextEncoder();

function encodeEvent(data: unknown) {
  return encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
}

export default defineHandler((event) => {
  const port = parsePort(event);
  const client = getOpencodeClient(port);
  const abort = new AbortController();

  event.res.headers.set("Content-Type", "text/event-stream");
  event.res.headers.set("Cache-Control", "no-cache, no-transform");
  event.res.headers.set("Connection", "keep-alive");
  event.res.headers.set("X-Accel-Buffering", "no");
  event.res.headers.set("X-Content-Type-Options", "nosniff");

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const events = await client.event.subscribe(undefined, {
          signal: abort.signal,
          sseMaxRetryAttempts: 0,
        });

        for await (const item of events.stream) {
          if (abort.signal.aborted) break;
          controller.enqueue(encodeEvent(item));
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          controller.enqueue(
            encodeEvent({
              id: `mando-event-error-${Date.now()}`,
              type: "mando.event.error",
              properties: {
                message:
                  error instanceof Error
                    ? error.message
                    : "OpenCode event stream failed",
              },
            }),
          );
        }
      } finally {
        try {
          controller.close();
        } catch {
          // The client may have already closed the stream.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
});

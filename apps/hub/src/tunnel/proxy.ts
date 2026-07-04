import type { Frame } from "@mando/protocol";
import type { Conn } from "./registry";

export type ProxyRequestInit = {
  method: string;
  path: string;
  headers: Record<string, string>;
  // base64-encoded request body, or null for a bodyless request (GET/HEAD).
  body: string | null;
};

export type ProxyRequestConfig = {
  // Timeout, in ms, for the agent to send `response_begin`. This is the
  // ONLY thing the timeout guards -- see the module comment above
  // proxyRequest for the full policy.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

// proxyRequest sends one `http_request` frame over `conn` and turns the
// agent's response_begin/response_chunk*/response_end (or response_error)
// frames into a single streamed Response, so SSE-style bodies flow to the
// browser incrementally instead of being buffered until response_end.
//
// Timeout policy (exact, since this is easy to get subtly wrong): the
// `timeoutMs` (default 120s) window covers ONLY the wait for
// `response_begin` -- i.e. "establishing" the response. The instant
// `response_begin` arrives, the timer is cleared and never restarted for
// the rest of that request's lifetime. This means a long-lived SSE/stream
// response is never killed by this timeout once headers have arrived, no
// matter how long the agent takes between chunks or how long the stream
// stays open -- exactly the "exempt once begin arrives" behavior the task
// brief calls for. The tradeoff: a slow-but-finite non-streaming response
// that starts producing chunks immediately but takes >120s to reach
// response_end is also never killed by this mechanism (there is no
// separate idle-between-chunks or total-duration timeout). That's an
// intentional simplification -- inventing a second timeout axis wasn't
// asked for and would risk killing legitimate long-running SSE sessions,
// which is the exact failure mode the brief is protecting against.
//
// Cancel + handler-cleanup policy: the returned Response's body is a
// ReadableStream. If the browser/consumer disconnects or explicitly
// cancels its reader, the stream's `cancel()` callback fires (per the
// Streams spec, and per Bun's server: an aborted client connection cancels
// the Response body stream it was reading). That callback sends a
// `cancel` frame for this request's id AND calls `conn.offResponse(id)`
// to drop our handler -- addressing the leak flagged in task 2.7 (nothing
// removed a handler if a terminal response frame never arrived). Calling
// `offResponse` more than once (e.g. once from cancel, once from a
// response_end that was already in flight) is safe: it's a no-op if the
// handler is already gone.
export function proxyRequest(conn: Conn, init: ProxyRequestInit, config: ProxyRequestConfig = {}): Promise<Response> {
  const id = crypto.randomUUID();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<Response>((resolve) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    // Becomes true once response_begin resolves this promise (success) or
    // a pre-begin failure (timeout/response_error) resolves it instead.
    let began = false;

    function cleanup(): void {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = null;
      conn.offResponse(id);
    }

    function resolveWithError(status: number, code: string, message: string): void {
      if (began) return;
      began = true;
      cleanup();
      resolve(Response.json({ error: code, message }, { status }));
    }

    timeoutTimer = setTimeout(() => {
      resolveWithError(504, "proxy_timeout", `agent did not respond within ${timeoutMs}ms`);
    }, timeoutMs);

    conn.onResponse(id, (frame: Frame) => {
      switch (frame.type) {
        case "response_begin": {
          if (began) return; // already timed out or errored; ignore a late begin.
          began = true;
          // Streaming is exempt from the timeout from this point on -- see
          // the policy comment above.
          if (timeoutTimer) clearTimeout(timeoutTimer);
          timeoutTimer = null;

          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
            },
            cancel() {
              conn.send({ type: "cancel", id, payload: {} });
              cleanup();
            },
          });

          resolve(new Response(stream, { status: frame.payload.status, headers: frame.payload.headers }));
          return;
        }
        case "response_chunk": {
          controller?.enqueue(Buffer.from(frame.payload.data, "base64"));
          return;
        }
        case "response_end": {
          controller?.close();
          cleanup();
          return;
        }
        case "response_error": {
          if (!began) {
            resolveWithError(502, frame.payload.code, frame.payload.message);
            return;
          }
          controller?.error(new Error(`${frame.payload.code}: ${frame.payload.message}`));
          cleanup();
          return;
        }
        default:
          // onResponse is only ever fed response_* frames by tunnel/ws.ts.
          return;
      }
    });

    conn.send({
      type: "http_request",
      id,
      payload: { method: init.method, path: init.path, headers: init.headers, body: init.body },
    });
  });
}

import type { Frame } from "@mando/protocol";

// @mando/protocol only exports the union `Frame` type (see frames.ts), not
// a standalone type per frame. Narrowing it here (rather than modifying
// the shared protocol package) keeps this task's footprint to the agent
// package while still giving `forward` the exact parameter name the brief
// specifies.
export type HttpRequestFrame = Extract<Frame, { type: "http_request" }>;

export interface ForwardOptions {
  opencodePassword?: string;
  // Lets a caller (daemon.ts, tracking one AbortController per in-flight
  // request id) cancel this specific forward when the hub sends a
  // `cancel` frame for it, or when the local opencode server hangs.
  // Aborting always resolves the same terminal response_error frame with
  // code "cancelled" -- whether the abort lands before response_begin was
  // ever sent (the fetch itself rejects) or mid-stream (the body reader
  // rejects once the fetch's AbortSignal fires) -- rather than silently
  // ceasing. A post-begin cancelled frame may arrive after the hub has
  // already dropped its response handler (see apps/hub/src/tunnel/proxy.ts
  // `cancel()`'s immediate `offResponse`), in which case it's a harmless
  // no-op on the hub side; sending it anyway keeps forward's contract
  // simple (exactly one terminal frame per invocation, always) and gives
  // any future consumer of `send` a real signal that the request was
  // cancelled rather than requiring it to infer that from silence.
  signal?: AbortSignal;
}

// Headers that must never be forwarded verbatim to the local opencode
// server: `host` names the hub/tunnel, not opencode, and `connection` /
// `content-length` are hop-by-hop / entity-length headers computed by the
// original transport -- stale values here can make the local fetch error
// out or make opencode mis-parse the body. Mirrors the equivalent
// stripping done hub-side (apps/hub/src/proxy/routes.ts, tunnel/proxy.ts).
const EXCLUDED_REQUEST_HEADERS = new Set(["host", "connection", "content-length"]);
const EXCLUDED_RESPONSE_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

function filterHeaders(raw: Record<string, string>, excluded: Set<string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!excluded.has(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}

function basicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

// True once `signal` has actually fired -- used to tell a genuine abort
// apart from an unrelated fetch/stream failure so the right response_error
// code ("cancelled" vs "fetch_failed"/"stream_failed") gets sent.
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

// forward turns one `http_request` frame into a local fetch against
// opencode (at `localBase`) and streams the result back through `send` as
// response_begin -> response_chunk* -> response_end, or response_error if
// the local fetch itself fails. Every frame it emits carries the same `id`
// as `frame`, per the protocol.
//
// Streaming: the response body is read via `response.body.getReader()` and
// each chunk read is immediately base64-encoded and sent as its own
// response_chunk frame. The whole body is never buffered before emitting,
// so SSE-style long-lived responses from opencode flow through
// incrementally instead of waiting for completion.
export async function forward(
  frame: HttpRequestFrame,
  localBase: string,
  send: (f: Frame) => void,
  opts: ForwardOptions = {},
): Promise<void> {
  const { id, payload } = frame;
  const { method, path, headers: rawHeaders, body } = payload;

  const headers = filterHeaders(rawHeaders, EXCLUDED_REQUEST_HEADERS);
  if (opts.opencodePassword) {
    headers["Authorization"] = basicAuthHeader(opts.opencodePassword);
  }

  let response: Response;
  try {
    response = await fetch(`${localBase}${path}`, {
      method,
      headers,
      body: body ? Buffer.from(body, "base64") : undefined,
      signal: opts.signal,
    });
  } catch (error) {
    const cancelled = isAborted(opts.signal);
    send({
      type: "response_error",
      id,
      payload: {
        code: cancelled ? "cancelled" : "fetch_failed",
        message: cancelled ? "request cancelled" : error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
  });

  send({
    type: "response_begin",
    id,
    payload: { status: response.status, headers: responseHeaders },
  });

  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          send({
            type: "response_chunk",
            id,
            payload: { data: Buffer.from(value).toString("base64") },
          });
        }
      }
    } catch (error) {
      // A mid-stream read failure (connection dropped after response_begin
      // was already sent, OR opts.signal fired -- aborting the fetch also
      // aborts its body stream, which surfaces here as a rejected read).
      // response_error is valid post-begin -- the hub side treats it as an
      // in-flight stream error, not a fresh failure.
      const cancelled = isAborted(opts.signal);
      send({
        type: "response_error",
        id,
        payload: {
          code: cancelled ? "cancelled" : "stream_failed",
          message: cancelled ? "request cancelled" : error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
  }

  send({ type: "response_end", id, payload: {} });
}

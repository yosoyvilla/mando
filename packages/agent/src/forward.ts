import type { Frame } from "@mando/protocol";

// @mando/protocol only exports the union `Frame` type (see frames.ts), not
// a standalone type per frame. Narrowing it here (rather than modifying
// the shared protocol package) keeps this task's footprint to the agent
// package while still giving `forward` the exact parameter name the brief
// specifies.
export type HttpRequestFrame = Extract<Frame, { type: "http_request" }>;

export interface ForwardOptions {
  opencodePassword?: string;
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
    });
  } catch (error) {
    send({
      type: "response_error",
      id,
      payload: {
        code: "fetch_failed",
        message: error instanceof Error ? error.message : String(error),
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
      // was already sent). response_error is valid post-begin -- the hub
      // side treats it as an in-flight stream error, not a fresh failure.
      send({
        type: "response_error",
        id,
        payload: {
          code: "stream_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
  }

  send({ type: "response_end", id, payload: {} });
}

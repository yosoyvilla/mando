import { z } from "zod";

const base64 = z.string();
const headers = z.record(z.string(), z.string());

export const HelloFrame = z.object({
  type: z.literal("hello"),
  id: z.string(),
  payload: z.object({
    token: z.string(),
    machineName: z.string().min(1),
    opencodePort: z.number().int().positive(),
    agentVersion: z.string(),
    // Optional (not required) so an old agent build that predates protocol
    // versioning still parses cleanly here -- the hub branches on its
    // absence to send a clean version_mismatch error instead of this
    // schema rejecting the frame outright (which the hub's onMessage
    // handler treats as silent malformed-frame noise, dropping the
    // connection with no explanation). See @mando/protocol's
    // PROTOCOL_VERSION (version.ts) and apps/hub/src/tunnel/ws.ts's
    // handleHello.
    protocolVersion: z.number().int().optional(),
  }),
});

export const RegisteredFrame = z.object({
  type: z.literal("registered"),
  id: z.string(),
  payload: z.object({ machineId: z.string() }),
});

export const ErrorFrame = z.object({
  type: z.literal("error"),
  id: z.string(),
  payload: z.object({ code: z.string(), message: z.string() }),
});

export const HttpRequestFrame = z.object({
  type: z.literal("http_request"),
  id: z.string(),
  payload: z.object({
    method: z.string(),
    path: z.string(),
    headers,
    body: base64.nullable(),
  }),
});

export const ResponseBeginFrame = z.object({
  type: z.literal("response_begin"),
  id: z.string(),
  // Bounded to the range `new Response(..., { status })` actually accepts
  // (200-599 per the Fetch/WHATWG spec) -- outside that, the hub's
  // `new Response(stream, { status })` (apps/hub/src/tunnel/proxy.ts)
  // throws a RangeError that escapes the message-handling code and hangs
  // the request. Rejecting it here folds an out-of-range status into the
  // existing malformed-frame ignore path instead.
  payload: z.object({ status: z.number().int().min(200).max(599), headers }),
});

export const ResponseChunkFrame = z.object({
  type: z.literal("response_chunk"),
  id: z.string(),
  payload: z.object({ data: base64 }),
});

export const ResponseEndFrame = z.object({
  type: z.literal("response_end"),
  id: z.string(),
  payload: z.object({}).strict(),
});

export const ResponseErrorFrame = z.object({
  type: z.literal("response_error"),
  id: z.string(),
  payload: z.object({ code: z.string(), message: z.string() }),
});

export const CancelFrame = z.object({
  type: z.literal("cancel"),
  id: z.string(),
  payload: z.object({}).strict(),
});

export const PingFrame = z.object({ type: z.literal("ping"), id: z.string() });
export const PongFrame = z.object({ type: z.literal("pong"), id: z.string() });

export const StatusFrame = z.object({
  type: z.literal("status"),
  id: z.string(),
  payload: z.object({ opencodeHealthy: z.boolean() }),
});

export const FrameSchema = z.discriminatedUnion("type", [
  HelloFrame, RegisteredFrame, ErrorFrame, HttpRequestFrame,
  ResponseBeginFrame, ResponseChunkFrame, ResponseEndFrame, ResponseErrorFrame,
  CancelFrame, PingFrame, PongFrame, StatusFrame,
]);

export type Frame = z.infer<typeof FrameSchema>;

export function parseFrame(raw: string): Frame {
  return FrameSchema.parse(JSON.parse(raw));
}

export function serializeFrame(f: Frame): string {
  return JSON.stringify(FrameSchema.parse(f));
}

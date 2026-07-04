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
  payload: z.object({ status: z.number().int(), headers }),
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

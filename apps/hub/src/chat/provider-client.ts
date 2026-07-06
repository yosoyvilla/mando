import { assertSafeProviderUrl, UnsafeProviderUrlError } from "../providers/url-guard";

// Bounds how long the hub will wait on the user's provider for an entire
// streaming completion (not just the initial response) -- much longer than
// model-client.ts's 10s (a JSON list call) or images/provider-client.ts's
// 60s (a single generation), since a real chat reply can legitimately
// stream for minutes, but this still must be finite: an unbounded fetch
// here would let one hung provider tie up a connection forever.
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

// Hard cap on the total assistant content this generator will ever yield
// for one request, independent of the provider's own limits -- protects
// the hub's memory/response size against a misbehaving or malicious
// provider that never sends [DONE], same "bound the untrusted response"
// rationale as images/provider-client.ts's IMAGE_MAX_BYTES.
export const MAX_STREAM_CONTENT_CHARS = 200_000;

export type ChatProviderErrorReason = "unsafe_url" | "request_failed" | "invalid_response" | "too_large";

export class ChatProviderError extends Error {
  readonly reason: ChatProviderErrorReason;

  constructor(reason: ChatProviderErrorReason, message: string) {
    super(message);
    this.name = "ChatProviderError";
    this.reason = reason;
  }
}

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessageInput = {
  role: "system" | "user" | "assistant";
  content: string | ChatMessagePart[];
};

export type StreamChatInput = {
  baseUrl: string;
  apiKey: string;
  model: string | null;
  messages: ChatMessageInput[];
};

// One emitted chunk of the assistant's reply. `reasoning` is captured
// separately from `content` (never concatenated together) so a caller that
// only wants the final answer can ignore it -- per the plan, reasoning_content
// is optional to surface, not required.
export type ChatDelta = { content?: string; reasoning?: string };

export type AssertSafeUrl = (rawUrl: string) => Promise<void>;

// Same DI shape as images/provider-client.ts's ProviderClientDeps -- tests
// substitute a permissive stub for the SSRF guard when pointing at a real
// local fake streaming server (loopback, plain http), which the real guard
// correctly always rejects.
export type ChatClientDeps = {
  assertSafeUrl?: AssertSafeUrl;
};

function joinPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Re-validates the base URL immediately before this specific request, per
// the plan's Global Constraints -- copied verbatim from
// images/provider-client.ts's guardUrl(), since a DNS name that resolved
// safely at save time (providers/routes.ts PUT) can resolve to a
// private/metadata address now (DNS rebinding).
async function guardUrl(baseUrl: string, deps: ChatClientDeps): Promise<void> {
  const assertSafeUrl = deps.assertSafeUrl ?? assertSafeProviderUrl;
  try {
    await assertSafeUrl(baseUrl);
  } catch (err) {
    if (err instanceof UnsafeProviderUrlError) {
      throw new ChatProviderError("unsafe_url", err.message);
    }
    throw err;
  }
}

type OpenAiStreamChoice = { delta?: { content?: unknown; reasoning_content?: unknown } };
type OpenAiStreamChunk = { choices?: OpenAiStreamChoice[] };

// Parses one `data: ...` SSE line (already stripped of the "data:" prefix
// and surrounding whitespace) into a delta, or null if the line carries
// nothing this caller cares about (a different/unknown shape, or an event
// this codec doesn't need). Malformed JSON is swallowed rather than failing
// the whole stream -- one bad chunk from an otherwise-working provider
// shouldn't abort an in-progress reply the user is already reading.
function parseSseData(data: string): ChatDelta | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }

  const choice = (json as OpenAiStreamChunk)?.choices?.[0];
  const delta = choice?.delta;
  if (!delta) return null;

  const out: ChatDelta = {};
  if (typeof delta.content === "string" && delta.content.length > 0) out.content = delta.content;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
    out.reasoning = delta.reasoning_content;
  }
  return out.content || out.reasoning ? out : null;
}

// POST {baseUrl}/chat/completions with stream:true -- OpenAI-compatible
// streaming chat, verified live (per the plan) to emit
// `data: {choices:[{delta:{content|reasoning_content}}]}` lines terminated
// by a literal `data: [DONE]`. Yields one ChatDelta per SSE data line that
// carries content/reasoning; the caller (chat/routes.ts) is responsible for
// forwarding those deltas to the browser and accumulating the final
// persisted message.
export async function* streamChat(input: StreamChatInput, deps: ChatClientDeps = {}): AsyncGenerator<ChatDelta> {
  await guardUrl(input.baseUrl, deps);

  let res: Response;
  try {
    res = await fetch(joinPath(input.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: true }),
      redirect: "error",
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
    });
  } catch {
    throw new ChatProviderError("request_failed", "failed to reach the configured provider");
  }

  if (!res.ok) {
    throw new ChatProviderError("request_failed", `provider returned HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new ChatProviderError("invalid_response", "provider response had no body to stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalChars = 0;

  try {
    while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch {
        throw new ChatProviderError("request_failed", "the provider stream was interrupted");
      }
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") return;
        if (data.length === 0) continue;

        const delta = parseSseData(data);
        if (!delta) continue;

        totalChars += (delta.content?.length ?? 0) + (delta.reasoning?.length ?? 0);
        if (totalChars > MAX_STREAM_CONTENT_CHARS) {
          throw new ChatProviderError("too_large", "provider response exceeded the streamed-content cap");
        }

        yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

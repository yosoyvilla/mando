import { assertSafeProviderUrl, UnsafeProviderUrlError } from "./url-guard";

// A models listing is a small, fast JSON call -- unlike image generation
// (images/provider-client.ts's 60s REQUEST_TIMEOUT_MS), there's no reason
// to let a hung/slow provider tie up a request for anywhere near that
// long, so this is a much tighter bound.
const REQUEST_TIMEOUT_MS = 10_000;

export type ProviderModelsErrorReason = "unsafe_url" | "request_failed" | "invalid_response";

export class ProviderModelsError extends Error {
  readonly reason: ProviderModelsErrorReason;

  constructor(reason: ProviderModelsErrorReason, message: string) {
    super(message);
    this.name = "ProviderModelsError";
    this.reason = reason;
  }
}

export type AssertSafeUrl = (rawUrl: string) => Promise<void>;

export type ProviderModel = { id: string };

// Same DI shape as images/provider-client.ts's ProviderClientDeps -- tests
// substitute a permissive stub for the SSRF guard when pointing at a real
// local fake provider server (loopback, plain http), which the real guard
// correctly always rejects.
export type ModelClientDeps = {
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
async function guardUrl(baseUrl: string, deps: ModelClientDeps): Promise<void> {
  const assertSafeUrl = deps.assertSafeUrl ?? assertSafeProviderUrl;
  try {
    await assertSafeUrl(baseUrl);
  } catch (err) {
    if (err instanceof UnsafeProviderUrlError) {
      throw new ProviderModelsError("unsafe_url", err.message);
    }
    throw err;
  }
}

// GET {baseUrl}/models -- OpenAI-compatible model listing. Returns the raw
// list (only `id` is extracted from each entry); chat-capability filtering
// (dropping embedding/whisper/kokoro/rerank/flux-* ids) is left to the
// caller (apps/web's provider-settings.tsx), since the hub has no reliable
// way to know which ids are chat-capable for an arbitrary OpenAI-compatible
// provider.
export async function listModels(
  input: { baseUrl: string; apiKey: string },
  deps: ModelClientDeps = {},
): Promise<ProviderModel[]> {
  await guardUrl(input.baseUrl, deps);

  let res: Response;
  try {
    res = await fetch(joinPath(input.baseUrl, "/models"), {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderModelsError("request_failed", "failed to reach the configured provider");
  }

  if (!res.ok) {
    throw new ProviderModelsError("request_failed", `provider returned HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ProviderModelsError("invalid_response", "provider response was not valid JSON");
  }

  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new ProviderModelsError("invalid_response", "provider response did not include a data array");
  }

  const models: ProviderModel[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id.length > 0) models.push({ id });
  }
  return models;
}

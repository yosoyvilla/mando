import { assertSafeProviderUrl, UnsafeProviderUrlError } from "../providers/url-guard";

// Hard cap on the DECODED image bytes returned by the provider (generation
// or edit) -- enforced before insertImage ever sees the bytes, per the
// plan's Global Constraints ("generated image size cap"). Also reused as
// the Hono bodyLimit for POST /api/v1/images/edits (images/routes.ts) so
// an oversized multipart upload from the caller is rejected the same way
// an oversized provider response is.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// Bounds how long the hub will wait on the user's (arbitrary, potentially
// slow or hung) provider before giving up -- image generation/editing is
// slower than a typical JSON API call, so this is generous relative to
// other outbound calls in this codebase, but still finite: an unbounded
// fetch here would let a single request tie up a connection indefinitely.
const REQUEST_TIMEOUT_MS = 60_000;

export type ProviderImageErrorReason = "unsafe_url" | "request_failed" | "invalid_response" | "too_large";

export class ProviderImageError extends Error {
  readonly reason: ProviderImageErrorReason;

  constructor(reason: ProviderImageErrorReason, message: string) {
    super(message);
    this.name = "ProviderImageError";
    this.reason = reason;
  }
}

export type AssertSafeUrl = (rawUrl: string) => Promise<void>;

export type ProviderImageResult = { bytes: Buffer; mime: string };

export type GenerateImageInput = {
  baseUrl: string;
  apiKey: string;
  model: string | null;
  prompt: string;
  size?: string;
};

export type EditImageInput = {
  baseUrl: string;
  apiKey: string;
  model: string | null;
  prompt: string;
  sourceBytes: Buffer;
  sourceMime: string;
  size?: string;
};

// Every exported call below takes this as an optional second argument so
// tests can substitute a permissive stub for the SSRF guard when they
// need to point at a real local fake provider server (loopback, plain
// http) -- addresses/schemes the real guard correctly always rejects.
// SSRF behavior itself (the default) is exhaustively covered by
// url-guard.test.ts and providers.test.ts; these callers only need to
// verify request/response mechanics, so DI keeps that concern isolated
// instead of every test needing a real public HTTPS provider.
export type ProviderClientDeps = {
  assertSafeUrl?: AssertSafeUrl;
};

function joinPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

// Re-validates the base URL immediately before this specific request --
// required per the plan's Global Constraints even though the same URL
// was already validated at save time (providers/routes.ts PUT), because a
// DNS name that resolved safely then can resolve to a private/metadata
// address now (DNS rebinding).
async function guardUrl(baseUrl: string, deps: ProviderClientDeps): Promise<void> {
  const assertSafeUrl = deps.assertSafeUrl ?? assertSafeProviderUrl;
  try {
    await assertSafeUrl(baseUrl);
  } catch (err) {
    if (err instanceof UnsafeProviderUrlError) {
      throw new ProviderImageError("unsafe_url", err.message);
    }
    throw err;
  }
}

function decodeAndCapB64Json(b64: string): Buffer {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw new ProviderImageError(
      "too_large",
      `provider image (${bytes.length} bytes) exceeds the ${IMAGE_MAX_BYTES}-byte cap`,
    );
  }
  return bytes;
}

// Shared response handling for both /images/generations and
// /images/edits -- both are documented (and verified live, per the plan)
// to return the same `{ data: [{ b64_json }] }` shape when
// response_format:"b64_json" is requested.
async function parseImagesResponse(res: Response): Promise<ProviderImageResult> {
  if (!res.ok) {
    throw new ProviderImageError("request_failed", `provider returned HTTP ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ProviderImageError("invalid_response", "provider response was not valid JSON");
  }

  const data = (json as { data?: unknown })?.data;
  const b64 = Array.isArray(data) ? (data[0] as { b64_json?: unknown } | undefined)?.b64_json : undefined;
  if (typeof b64 !== "string" || b64.length === 0) {
    throw new ProviderImageError("invalid_response", "provider response did not include b64_json image data");
  }

  return { bytes: decodeAndCapB64Json(b64), mime: "image/png" };
}

// Wraps fetch failures (network errors, DNS failures, and -- critically --
// redirect:"error" throwing when the provider tries to 302 somewhere else)
// into the same typed error every other failure mode here uses, so
// callers (images/routes.ts) have one error type to branch on rather than
// needing to catch a raw TypeError from fetch.
async function requestJson(url: string, apiKey: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderImageError("request_failed", "failed to reach the configured provider");
  }
}

async function requestMultipart(url: string, apiKey: string, form: FormData): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderImageError("request_failed", "failed to reach the configured provider");
  }
}

// POST {baseUrl}/images/generations -- OpenAI-compatible image generation.
// The API key is used only as this request's Bearer credential; it is
// never logged, and no error path below includes it in a thrown message.
export async function generateImage(
  input: GenerateImageInput,
  deps: ProviderClientDeps = {},
): Promise<ProviderImageResult> {
  await guardUrl(input.baseUrl, deps);

  const res = await requestJson(joinPath(input.baseUrl, "/images/generations"), input.apiKey, {
    model: input.model,
    prompt: input.prompt,
    size: input.size ?? "1024x1024",
    response_format: "b64_json",
  });

  return parseImagesResponse(res);
}

// POST {baseUrl}/images/edits -- multipart, per the OpenAI-compatible
// contract (the generations endpoint is plain JSON; edits is not, since
// it must carry the source image's raw bytes).
export async function editImage(
  input: EditImageInput,
  deps: ProviderClientDeps = {},
): Promise<ProviderImageResult> {
  await guardUrl(input.baseUrl, deps);

  const form = new FormData();
  if (input.model) form.set("model", input.model);
  form.set("prompt", input.prompt);
  if (input.size) form.set("size", input.size);
  form.set("response_format", "b64_json");
  form.set("image", new Blob([new Uint8Array(input.sourceBytes)], { type: input.sourceMime }), "image");

  const res = await requestMultipart(joinPath(input.baseUrl, "/images/edits"), input.apiKey, form);

  return parseImagesResponse(res);
}

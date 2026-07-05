import { Hono, type Context } from "hono";
import { z } from "zod";
import type postgres from "postgres";
import type { Config } from "../config";
import { requireUser, type AuthVariables } from "../auth/middleware";
import { decryptSecret, encryptSecret, isEncryptionConfigured } from "../crypto/secretbox";
import { assertSafeProviderUrl, UnsafeProviderUrlError } from "./url-guard";
import { deleteProviderSettings, getProviderSettings, upsertProviderSettings } from "./repo";
import { listModels, ProviderModelsError, type ModelClientDeps } from "./model-client";

type Sql = ReturnType<typeof postgres>;

const putSchema = z.object({
  baseUrl: z.string().min(1),
  // Optional: omitted (or not sent at all) means "keep the existing
  // encrypted key" -- the caller only ever gets a write-only field, so
  // there's no way for a client to resubmit the current key even if it
  // wanted to.
  apiKey: z.string().min(1).optional(),
  imageModel: z.string().min(1).nullable().optional(),
  chatModel: z.string().min(1).nullable().optional(),
});

// Maps a ProviderModelsError to an HTTP response, same shape as
// images/routes.ts's providerErrorResponse -- every message here is a
// short, static, developer-authored string from model-client.ts (never the
// provider's raw response body and never the API key).
function providerModelsErrorResponse(err: ProviderModelsError): { status: 400 | 502; body: { error: string } } {
  if (err.reason === "unsafe_url") return { status: 400, body: { error: "provider_unsafe_url" } };
  return { status: 502, body: { error: `provider_${err.reason}` } };
}

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

// modelClientDeps defaults to the real SSRF guard (model-client.ts) in
// production; buildApp (app.ts) only overrides it in tests that need a
// real local fake provider server, which the real guard correctly always
// rejects (loopback, plain http) -- same "injectable, defaults to the real
// thing" shape as imageRoutes' clientDeps param.
export function providerRoutes(
  sql: Sql,
  config: Config,
  modelClientDeps: ModelClientDeps = {},
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Every route here needs to encrypt or decrypt the stored key, so all of
  // them fail the same way (503, not 500) when MANDO_ENCRYPTION_KEY is
  // unset -- there is no partial/degraded mode where settings are readable
  // but not writable, or vice versa. Registered against both the exact
  // list path and the wildcard (mirrors images/routes.ts) so
  // /api/v1/provider/models is covered too.
  app.use("/api/v1/provider", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });
  app.use("/api/v1/provider/*", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });

  // Never includes the key itself, encrypted or not -- only whether one is
  // set. hasKey is derived from row presence, not from api_key_encrypted's
  // content, so this can't accidentally leak ciphertext length/shape either.
  app.get("/api/v1/provider", requireUser(sql), async (c) => {
    const settings = await getProviderSettings(sql, c.get("userId"));
    if (!settings) return c.json({ baseUrl: null, imageModel: null, chatModel: null, hasKey: false }, 200);
    return c.json(
      { baseUrl: settings.base_url, imageModel: settings.image_model, chatModel: settings.chat_model, hasKey: true },
      200,
    );
  });

  app.put("/api/v1/provider", requireUser(sql), async (c) => {
    const parsed = putSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { baseUrl, apiKey, imageModel, chatModel } = parsed.data;

    try {
      await assertSafeProviderUrl(baseUrl);
    } catch (err) {
      if (err instanceof UnsafeProviderUrlError) return c.json({ error: err.message }, 400);
      throw err;
    }

    const userId = c.get("userId");
    let apiKeyEncrypted: string;
    if (apiKey) {
      apiKeyEncrypted = encryptSecret(apiKey, config);
    } else {
      const existing = await getProviderSettings(sql, userId);
      if (!existing) {
        return c.json({ error: "apiKey is required when configuring a provider for the first time" }, 400);
      }
      apiKeyEncrypted = existing.api_key_encrypted;
    }

    await upsertProviderSettings(sql, userId, {
      baseUrl,
      apiKeyEncrypted,
      imageModel: imageModel ?? null,
      chatModel: chatModel ?? null,
    });

    return c.json({ ok: true }, 200);
  });

  app.delete("/api/v1/provider", requireUser(sql), async (c) => {
    await deleteProviderSettings(sql, c.get("userId"));
    return c.json({ ok: true }, 200);
  });

  // Proxies the user's configured provider's model list -- requires a
  // provider row (400 provider_not_configured otherwise, same shape as
  // images/routes.ts) since there's no baseUrl/key to call out with
  // without one. Returns the raw list (only `id` survives model-client.ts's
  // parsing); the chat-capability filter (dropping embedding/whisper/
  // kokoro/rerank/flux-* ids) is applied client-side, not here, since the
  // hub has no reliable way to know which ids are chat-capable for an
  // arbitrary OpenAI-compatible provider.
  app.get("/api/v1/provider/models", requireUser(sql), async (c) => {
    const settings = await getProviderSettings(sql, c.get("userId"));
    if (!settings) return c.json({ error: "provider_not_configured" }, 400);

    const apiKey = decryptSecret(settings.api_key_encrypted, config);
    try {
      const models = await listModels({ baseUrl: settings.base_url, apiKey }, modelClientDeps);
      return c.json(models, 200);
    } catch (err) {
      if (err instanceof ProviderModelsError) {
        const { status, body } = providerModelsErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }
  });

  return app;
}

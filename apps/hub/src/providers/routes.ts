import { Hono, type Context } from "hono";
import { z } from "zod";
import type postgres from "postgres";
import type { Config } from "../config";
import { requireUser, type AuthVariables } from "../auth/middleware";
import { encryptSecret, isEncryptionConfigured } from "../crypto/secretbox";
import { assertSafeProviderUrl, UnsafeProviderUrlError } from "./url-guard";
import { deleteProviderSettings, getProviderSettings, upsertProviderSettings } from "./repo";

type Sql = ReturnType<typeof postgres>;

const putSchema = z.object({
  baseUrl: z.string().min(1),
  // Optional: omitted (or not sent at all) means "keep the existing
  // encrypted key" -- the caller only ever gets a write-only field, so
  // there's no way for a client to resubmit the current key even if it
  // wanted to.
  apiKey: z.string().min(1).optional(),
  imageModel: z.string().min(1).nullable().optional(),
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function providerRoutes(sql: Sql, config: Config): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Every route here needs to encrypt or decrypt the stored key, so all
  // three fail the same way (503, not 500) when MANDO_ENCRYPTION_KEY is
  // unset -- there is no partial/degraded mode where settings are readable
  // but not writable, or vice versa.
  app.use("/api/v1/provider", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });

  // Never includes the key itself, encrypted or not -- only whether one is
  // set. hasKey is derived from row presence, not from api_key_encrypted's
  // content, so this can't accidentally leak ciphertext length/shape either.
  app.get("/api/v1/provider", requireUser(sql), async (c) => {
    const settings = await getProviderSettings(sql, c.get("userId"));
    if (!settings) return c.json({ baseUrl: null, imageModel: null, hasKey: false }, 200);
    return c.json({ baseUrl: settings.base_url, imageModel: settings.image_model, hasKey: true }, 200);
  });

  app.put("/api/v1/provider", requireUser(sql), async (c) => {
    const parsed = putSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { baseUrl, apiKey, imageModel } = parsed.data;

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
    });

    return c.json({ ok: true }, 200);
  });

  app.delete("/api/v1/provider", requireUser(sql), async (c) => {
    await deleteProviderSettings(sql, c.get("userId"));
    return c.json({ ok: true }, 200);
  });

  return app;
}

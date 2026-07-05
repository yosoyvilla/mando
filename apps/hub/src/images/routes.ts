import { Hono, type Context } from "hono";
import { z } from "zod";
import type postgres from "postgres";
import type { Config } from "../config";
import { requireUser, type AuthVariables } from "../auth/middleware";
import { decryptSecret, isEncryptionConfigured } from "../crypto/secretbox";
import { getProviderSettings } from "../providers/repo";
import { createImage, deleteImage, getFileRef, listMetadata, type ImageMetadata } from "./repo";
import { readImageFile } from "./storage";
import { editImage, generateImage, ProviderImageError, type ProviderClientDeps } from "./provider-client";

type Sql = ReturnType<typeof postgres>;

// Bounds the prompt itself (Global Constraints: "prompt length bound") --
// independent of, and much smaller than, IMAGE_MAX_BYTES which bounds the
// image bytes, not the text describing them.
const MAX_PROMPT_LENGTH = 4000;

const generateSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  size: z.string().min(1).max(32).optional(),
  // Deliberately NOT `.min(1).max(4)` -- an out-of-range value is CLAMPED
  // (clampImageCount below), not rejected, per the plan's Generation
  // richness task. Only the type (a number, if present at all) is
  // validated here.
  n: z.coerce.number().optional(),
});

const MAX_IMAGE_COUNT = 4;

// Coerces an arbitrary/absent `n` into a safe loop count: missing or NaN
// defaults to 1 (today's single-image behavior), and anything outside
// 1..MAX_IMAGE_COUNT is clamped to the nearest bound rather than rejected --
// a caller asking for 0 or 100 images gets 1 or 4, not a 400.
export function clampImageCount(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 1;
  return Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.trunc(n)));
}

// The json-body variant of POST /images/edits: edit an image already
// stored for this user (identified by id) rather than one uploaded fresh
// in this same request.
const editJsonSchema = z.object({
  sourceImageId: z.string().min(1),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  size: z.string().min(1).max(32).optional(),
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function toMetadata(row: ImageMetadata) {
  return {
    id: row.id,
    prompt: row.prompt,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    sourceKind: row.source_kind,
    createdAt: row.created_at,
  };
}

// Maps a ProviderImageError to an HTTP response. Every message here is a
// short, static, developer-authored string from provider-client.ts (never
// the provider's raw response body and never the API key), so there is no
// secret- or upstream-detail leak surface in the response.
function providerErrorResponse(err: ProviderImageError): { status: 400 | 502; body: { error: string } } {
  if (err.reason === "unsafe_url") return { status: 400, body: { error: "provider_unsafe_url" } };
  return { status: 502, body: { error: `provider_${err.reason}` } };
}

// A malformed :id (not a valid uuid) makes Postgres throw a cast error
// rather than returning zero rows -- folding that into the same "not
// found" outcome as a real, owner-mismatched id keeps 404 the only signal
// a caller gets either way (see auth/middleware.ts's requireMachineOwnership
// for the same fold-DB-errors-into-404 pattern).
async function getFileRefSafe(sql: Sql, id: string, userId: string) {
  try {
    return await getFileRef(sql, id, userId);
  } catch {
    return null;
  }
}

async function deleteImageSafe(sql: Sql, imageDir: string, id: string, userId: string): Promise<boolean> {
  try {
    return await deleteImage(sql, imageDir, id, userId);
  } catch {
    return false;
  }
}

// clientDeps defaults to the real SSRF guard (provider-client.ts) in
// production; buildApp (app.ts) only overrides it in tests that need a
// real local fake provider server, which the real guard correctly always
// rejects (loopback, plain http) -- same "injectable, defaults to the
// real thing" shape as AppDeps' rateLimits/tunnelPingIntervalMs.
export function imageRoutes(
  sql: Sql,
  config: Config,
  clientDeps: ProviderClientDeps = {},
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Every route here needs to decrypt the stored provider key (or, for
  // listing/raw/delete, exists only because the feature as a whole is
  // enabled), so all of them fail the same way (503, not 500 or a
  // confusing empty list) when MANDO_ENCRYPTION_KEY is unset -- same
  // shape as providers/routes.ts's equivalent gate. Registered against
  // both the exact list path and the wildcard so every sub-route is
  // covered regardless of Hono's wildcard-vs-exact-prefix matching.
  app.use("/api/v1/images", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });
  app.use("/api/v1/images/*", async (c, next) => {
    if (!isEncryptionConfigured(config)) return c.json({ error: "images_disabled" }, 503);
    await next();
  });

  app.post("/api/v1/images/generations", requireUser(sql), async (c) => {
    const parsed = generateSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const userId = c.get("userId");
    const settings = await getProviderSettings(sql, userId);
    if (!settings) return c.json({ error: "provider_not_configured" }, 400);

    const apiKey = decryptSecret(settings.api_key_encrypted, config);
    // "Count" is satisfied by calling the provider N times and storing each
    // result separately -- rather than trusting the provider's own `n`
    // param (unreliable across OpenAI-compatible providers) -- per the
    // plan's Generation richness task.
    const count = clampImageCount(parsed.data.n);
    try {
      const images: ImageMetadata[] = [];
      for (let i = 0; i < count; i += 1) {
        const result = await generateImage(
          {
            baseUrl: settings.base_url,
            apiKey,
            model: settings.image_model,
            prompt: parsed.data.prompt,
            size: parsed.data.size,
          },
          clientDeps,
        );
        const image = await createImage(sql, config.imageDir, userId, {
          prompt: parsed.data.prompt,
          mime: result.mime,
          bytes: result.bytes,
          sourceKind: "generation",
        });
        images.push(image);
      }
      return c.json({ images: images.map(toMetadata) }, 201);
    } catch (err) {
      if (err instanceof ProviderImageError) {
        const { status, body } = providerErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }
  });

  app.post("/api/v1/images/edits", requireUser(sql), async (c) => {
    const userId = c.get("userId");
    const settings = await getProviderSettings(sql, userId);
    if (!settings) return c.json({ error: "provider_not_configured" }, 400);

    const contentType = c.req.header("content-type") ?? "";
    let prompt: string;
    let size: string | undefined;
    let sourceBytes: Buffer;
    let sourceMime: string;

    if (contentType.includes("multipart/form-data")) {
      let body: Record<string, string | File>;
      try {
        body = (await c.req.parseBody()) as Record<string, string | File>;
      } catch {
        return c.json({ error: "invalid request" }, 400);
      }

      const promptField = body["prompt"];
      const imageField = body["image"];
      const sizeField = body["size"];
      if (typeof promptField !== "string" || promptField.length < 1 || promptField.length > MAX_PROMPT_LENGTH) {
        return c.json({ error: "invalid request" }, 400);
      }
      if (!(imageField instanceof File)) {
        return c.json({ error: "invalid request" }, 400);
      }

      prompt = promptField;
      size = typeof sizeField === "string" ? sizeField : undefined;
      sourceBytes = Buffer.from(await imageField.arrayBuffer());
      sourceMime = imageField.type || "application/octet-stream";
    } else {
      const parsed = editJsonSchema.safeParse(await parseJsonBody(c));
      if (!parsed.success) return c.json({ error: "invalid request" }, 400);

      const row = await getFileRefSafe(sql, parsed.data.sourceImageId, userId);
      if (!row) return c.json({ error: "not found" }, 404);

      prompt = parsed.data.prompt;
      size = parsed.data.size;
      sourceBytes = await readImageFile(config.imageDir, row.file_path);
      sourceMime = row.mime;
    }

    const apiKey = decryptSecret(settings.api_key_encrypted, config);
    try {
      const result = await editImage(
        {
          baseUrl: settings.base_url,
          apiKey,
          model: settings.image_model,
          prompt,
          size,
          sourceBytes,
          sourceMime,
        },
        clientDeps,
      );
      const image = await createImage(sql, config.imageDir, userId, {
        prompt,
        mime: result.mime,
        bytes: result.bytes,
        sourceKind: "edit",
      });
      return c.json(toMetadata(image), 201);
    } catch (err) {
      if (err instanceof ProviderImageError) {
        const { status, body } = providerErrorResponse(err);
        return c.json(body, status);
      }
      throw err;
    }
  });

  app.get("/api/v1/images", requireUser(sql), async (c) => {
    const rows = await listMetadata(sql, c.get("userId"));
    return c.json({ images: rows.map(toMetadata) }, 200);
  });

  // Reads the file off disk (images/storage.ts) as a single in-memory
  // Buffer, bounded by IMAGE_MAX_BYTES (enforced when the file was written,
  // never after) -- owner-scoped via getFileRef's WHERE user_id clause, so
  // a 404 here means "doesn't exist OR isn't yours", indistinguishably.
  app.get("/api/v1/images/:id/raw", requireUser(sql), async (c) => {
    const row = await getFileRefSafe(sql, c.req.param("id"), c.get("userId"));
    if (!row) return c.notFound();

    const bytes = await readImageFile(config.imageDir, row.file_path);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": row.mime,
        // Never let a browser sniff/execute stored bytes as anything other
        // than the declared mime type -- these bytes originated from a
        // user-configured third-party provider, not a trusted pipeline.
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.delete("/api/v1/images/:id", requireUser(sql), async (c) => {
    const deleted = await deleteImageSafe(sql, config.imageDir, c.req.param("id"), c.get("userId"));
    return c.json({ ok: true, deleted }, 200);
  });

  return app;
}

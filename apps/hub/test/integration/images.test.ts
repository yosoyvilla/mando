import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig, type Config } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { upsertProviderSettings } from "../../src/providers/repo";
import { encryptSecret } from "../../src/crypto/secretbox";
import { insertImage, getRaw } from "../../src/images/repo";
import { generateImage, editImage, ProviderImageError } from "../../src/images/provider-client";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

const ENCRYPTION_KEY_HEX = "cd".repeat(32);

const config: Config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
  PUBLIC_URL: "http://localhost:8080",
  MANDO_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX,
});

const disabledConfig: Config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
  PUBLIC_URL: "http://localhost:8080",
});

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueEmail(tag: string): string {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

async function registerAndLogin(
  app: ReturnType<typeof buildApp>,
  tag: string,
): Promise<{ userId: string; cookie: string }> {
  const email = uniqueEmail(tag);
  const password = "correct-password";
  const user = await createUser(sql, email, password);

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return { userId: user.id, cookie: setCookie.split(";")[0]! };
}

async function configureProvider(userId: string, baseUrl: string): Promise<void> {
  await upsertProviderSettings(sql, userId, {
    baseUrl,
    apiKeyEncrypted: encryptSecret("sk-test-provider-key", config),
    imageModel: "test-model",
  });
}

// Permissive SSRF-guard stub for provider-client tests below -- the real
// guard (exercised on its own in url-guard.test.ts and providers.test.ts)
// always and correctly rejects loopback/plain-http, which is exactly
// where these fake servers run. Injecting this isolates "does
// provider-client send/parse requests correctly" from "does the SSRF
// guard work", which is a separate, already-covered concern.
const noopGuard = async () => {};

function b64Png1x1(): string {
  // Smallest valid PNG (1x1, transparent) -- content doesn't matter, only
  // that it round-trips through base64 decode/encode correctly.
  return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
}

type FakeServer = { baseUrl: string; stop(): void; requests: Request[] };

function startFakeProviderServer(handler: (req: Request) => Promise<Response> | Response): FakeServer {
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push(req.clone());
      return handler(req);
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

// --- provider-client: generateImage ---

test("generateImage sends model/prompt/Bearer auth and decodes the returned b64_json", async () => {
  const fake = startFakeProviderServer(async (req) => {
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/images/generations");
    expect(req.headers.get("authorization")).toBe("Bearer sk-fake-key");
    const body = (await req.json()) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.prompt).toBe("a red bicycle");
    expect(body.response_format).toBe("b64_json");
    return Response.json({ data: [{ b64_json: b64Png1x1() }] });
  });

  try {
    const result = await generateImage(
      { baseUrl: fake.baseUrl, apiKey: "sk-fake-key", model: "test-model", prompt: "a red bicycle" },
      { assertSafeUrl: noopGuard },
    );
    expect(result.mime).toBe("image/png");
    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.bytes.equals(Buffer.from(b64Png1x1(), "base64"))).toBe(true);
  } finally {
    fake.stop();
  }
});

test("generateImage rejects an unsafe base URL by default (no stub injected)", async () => {
  await expect(
    generateImage({ baseUrl: "https://169.254.169.254/v1", apiKey: "sk-key", model: null, prompt: "x" }),
  ).rejects.toThrow();

  try {
    await generateImage({ baseUrl: "https://169.254.169.254/v1", apiKey: "sk-key", model: null, prompt: "x" });
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderImageError);
    expect((err as ProviderImageError).reason).toBe("unsafe_url");
  }
});

test("generateImage rejects a provider image over the 10MB cap and never returns it", async () => {
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
  const fake = startFakeProviderServer(() => Response.json({ data: [{ b64_json: oversized }] }));

  try {
    const promise = generateImage(
      { baseUrl: fake.baseUrl, apiKey: "sk-fake-key", model: null, prompt: "big" },
      { assertSafeUrl: noopGuard },
    );
    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderImageError);
      expect((err as ProviderImageError).reason).toBe("too_large");
    }
  } finally {
    fake.stop();
  }
});

test("generateImage rejects rather than follows a redirect from the provider", async () => {
  const target = startFakeProviderServer(() => Response.json({ data: [{ b64_json: b64Png1x1() }] }));
  const redirecting = startFakeProviderServer(
    () => new Response(null, { status: 302, headers: { Location: `${target.baseUrl}/images/generations` } }),
  );

  try {
    const promise = generateImage(
      { baseUrl: redirecting.baseUrl, apiKey: "sk-fake-key", model: null, prompt: "x" },
      { assertSafeUrl: noopGuard },
    );
    await expect(promise).rejects.toThrow();
    expect(target.requests.length).toBe(0);
  } finally {
    redirecting.stop();
    target.stop();
  }
});

// --- provider-client: editImage ---

test("editImage sends the source image + prompt as multipart and decodes the result", async () => {
  const fake = startFakeProviderServer(async (req) => {
    expect(new URL(req.url).pathname).toBe("/images/edits");
    expect(req.headers.get("authorization")).toBe("Bearer sk-fake-key");
    const form = await req.formData();
    expect(form.get("prompt")).toBe("make it blue");
    const image = form.get("image");
    expect(image).toBeInstanceOf(Blob);
    return Response.json({ data: [{ b64_json: b64Png1x1() }] });
  });

  try {
    const result = await editImage(
      {
        baseUrl: fake.baseUrl,
        apiKey: "sk-fake-key",
        model: "test-model",
        prompt: "make it blue",
        sourceBytes: Buffer.from(b64Png1x1(), "base64"),
        sourceMime: "image/png",
      },
      { assertSafeUrl: noopGuard },
    );
    expect(result.bytes.length).toBeGreaterThan(0);
  } finally {
    fake.stop();
  }
});

// --- images/repo: retention + owner scoping ---

test("insertImage's retention keeps only the newest 50 rows per user", async () => {
  const user = await createUser(sql, uniqueEmail("retention"), "correct-password");
  const bytes = Buffer.from("x");

  for (let i = 0; i < 55; i++) {
    await insertImage(sql, user.id, { prompt: `p${i}`, mime: "image/png", bytes, sourceKind: "generation" });
  }

  const rows = await sql`select count(*)::int as count from generated_images where user_id = ${user.id}`;
  expect(rows[0]!.count).toBe(50);

  const newest = await sql`
    select prompt from generated_images where user_id = ${user.id} order by created_at desc, id desc limit 1
  `;
  expect(newest[0]!.prompt).toBe("p54");
});

test("getRaw returns null (not another user's row) when the id belongs to a different user", async () => {
  const owner = await createUser(sql, uniqueEmail("owner"), "correct-password");
  const other = await createUser(sql, uniqueEmail("other"), "correct-password");

  const image = await insertImage(sql, owner.id, {
    prompt: "mine",
    mime: "image/png",
    bytes: Buffer.from("abc"),
    sourceKind: "generation",
  });

  expect(await getRaw(sql, image.id, other.id)).toBeNull();
  const ownRow = await getRaw(sql, image.id, owner.id);
  expect(ownRow?.bytes.toString()).toBe("abc");
});

// --- routes ---

test("POST /api/v1/images/generations returns 503 images_disabled when encryption is not configured", async () => {
  const app = buildApp({ sql, config: disabledConfig });
  const { cookie } = await registerAndLogin(app, "disabled");

  const res = await app.request("/api/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "images_disabled" });
});

test("GET /api/v1/images returns 503 images_disabled when encryption is not configured", async () => {
  const app = buildApp({ sql, config: disabledConfig });
  const { cookie } = await registerAndLogin(app, "disabled-list");

  const res = await app.request("/api/v1/images", { headers: { Cookie: cookie } });
  expect(res.status).toBe(503);
});

test("POST /api/v1/images/generations returns 400 provider_not_configured when the user has no provider row", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "no-provider");

  const res = await app.request("/api/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "provider_not_configured" });
});

test("GET /api/v1/images/:id/raw returns 404 for another user's image and hides the key from every response along the way", async () => {
  const app = buildApp({ sql, config });
  const { userId: ownerId, cookie: ownerCookie } = await registerAndLogin(app, "raw-owner");
  const { cookie: otherCookie } = await registerAndLogin(app, "raw-other");

  const image = await insertImage(sql, ownerId, {
    prompt: "mine",
    mime: "image/png",
    bytes: Buffer.from(b64Png1x1(), "base64"),
    sourceKind: "generation",
  });

  const ownRes = await app.request(`/api/v1/images/${image.id}/raw`, { headers: { Cookie: ownerCookie } });
  expect(ownRes.status).toBe(200);
  expect(ownRes.headers.get("content-type")).toBe("image/png");
  expect(ownRes.headers.get("x-content-type-options")).toBe("nosniff");

  const otherRes = await app.request(`/api/v1/images/${image.id}/raw`, { headers: { Cookie: otherCookie } });
  expect(otherRes.status).toBe(404);
});

test("DELETE /api/v1/images/:id removes only the caller's own image", async () => {
  const app = buildApp({ sql, config });
  const { userId: ownerId, cookie: ownerCookie } = await registerAndLogin(app, "delete-owner");
  const { cookie: otherCookie } = await registerAndLogin(app, "delete-other");

  const image = await insertImage(sql, ownerId, {
    prompt: "mine",
    mime: "image/png",
    bytes: Buffer.from(b64Png1x1(), "base64"),
    sourceKind: "generation",
  });

  const otherDelete = await app.request(`/api/v1/images/${image.id}`, {
    method: "DELETE",
    headers: { Cookie: otherCookie },
  });
  expect((await otherDelete.json()).deleted).toBe(false);

  const ownDelete = await app.request(`/api/v1/images/${image.id}`, {
    method: "DELETE",
    headers: { Cookie: ownerCookie },
  });
  expect((await ownDelete.json()).deleted).toBe(true);

  expect(await getRaw(sql, image.id, ownerId)).toBeNull();
});

test("POST /api/v1/images/generations rejects an unsafe provider base URL end to end via the real guard", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "route-unsafe-url");
  await configureProvider(userId, "https://169.254.169.254/v1");

  const res = await app.request("/api/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ prompt: "x" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "provider_unsafe_url" });
});

test("full generate flow via a fake provider stores bytes, returns metadata, and never leaks the key", async () => {
  const fake = startFakeProviderServer((req) => {
    expect(req.headers.get("authorization")).toBe("Bearer sk-test-provider-key");
    return Response.json({ data: [{ b64_json: b64Png1x1() }] });
  });
  try {
    // imagesProviderDeps overrides the SSRF guard only -- see AppDeps'
    // doc comment in app.ts. Everything else (auth, provider lookup,
    // decryption, storage, response shape) runs unmodified.
    const app = buildApp({ sql, config, imagesProviderDeps: { assertSafeUrl: noopGuard } });
    const { userId, cookie } = await registerAndLogin(app, "full-generate");
    await configureProvider(userId, fake.baseUrl);

    const res = await app.request("/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ prompt: "a red bicycle" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prompt).toBe("a red bicycle");
    expect(body.sourceKind).toBe("generation");
    expect(JSON.stringify(body)).not.toContain("sk-test-provider-key");

    const listRes = await app.request("/api/v1/images", { headers: { Cookie: cookie } });
    const listBody = await listRes.json();
    expect(listBody.images).toHaveLength(1);
    expect(listBody.images[0].id).toBe(body.id);

    const rawRes = await app.request(`/api/v1/images/${body.id}/raw`, { headers: { Cookie: cookie } });
    expect(rawRes.status).toBe(200);
    const rawBytes = Buffer.from(await rawRes.arrayBuffer());
    expect(rawBytes.equals(Buffer.from(b64Png1x1(), "base64"))).toBe(true);
  } finally {
    fake.stop();
  }
});

test("full edits flow (multipart) via a fake provider stores the edited bytes", async () => {
  const fake = startFakeProviderServer(async (req) => {
    const form = await req.formData();
    expect(form.get("prompt")).toBe("make it blue");
    expect(form.get("image")).toBeInstanceOf(Blob);
    return Response.json({ data: [{ b64_json: b64Png1x1() }] });
  });
  try {
    const app = buildApp({ sql, config, imagesProviderDeps: { assertSafeUrl: noopGuard } });
    const { userId, cookie } = await registerAndLogin(app, "full-edits");
    await configureProvider(userId, fake.baseUrl);

    const form = new FormData();
    form.set("prompt", "make it blue");
    form.set("image", new Blob([Buffer.from(b64Png1x1(), "base64")], { type: "image/png" }), "source.png");

    const res = await app.request("/api/v1/images/edits", {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sourceKind).toBe("edit");

    const rawRes = await app.request(`/api/v1/images/${body.id}/raw`, { headers: { Cookie: cookie } });
    expect(rawRes.status).toBe(200);
  } finally {
    fake.stop();
  }
});

test("exceeding the images rate limit returns 429", async () => {
  const app = buildApp({ sql, config, rateLimits: { images: { windowMs: 60_000, max: 2 } } });
  const { cookie } = await registerAndLogin(app, "images-ratelimit");

  function generate() {
    return app.request("/api/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ prompt: "x" }),
    });
  }

  expect((await generate()).status).toBe(400); // provider_not_configured, but under the limit
  expect((await generate()).status).toBe(400);
  const limited = await generate();
  expect(limited.status).toBe(429);
});

test("POST /api/v1/images/edits over the size cap is rejected by the body-limit middleware", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "edits-oversize");
  await configureProvider(userId, "https://example.com/v1");

  const oversized = new Blob([Buffer.alloc(10 * 1024 * 1024 + 1024, 7)], { type: "image/png" });
  const form = new FormData();
  form.set("prompt", "too big");
  form.set("image", oversized, "big.png");

  const res = await app.request("/api/v1/images/edits", { method: "POST", headers: { Cookie: cookie }, body: form });
  expect(res.status).toBe(413);
});

test("POST /api/v1/images/edits with a json sourceImageId edits an existing image and returns 404 for another user's id", async () => {
  const app = buildApp({ sql, config });
  const { userId: ownerId, cookie: ownerCookie } = await registerAndLogin(app, "edits-json-owner");
  const { cookie: otherCookie } = await registerAndLogin(app, "edits-json-other");
  await configureProvider(ownerId, "https://example.com/v1");

  const source = await insertImage(sql, ownerId, {
    prompt: "source",
    mime: "image/png",
    bytes: Buffer.from(b64Png1x1(), "base64"),
    sourceKind: "generation",
  });

  const otherRes = await app.request("/api/v1/images/edits", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: otherCookie },
    body: JSON.stringify({ sourceImageId: source.id, prompt: "edit it" }),
  });
  expect(otherRes.status).toBe(400); // otherCookie's user has no provider configured

  const ownRes = await app.request("/api/v1/images/edits", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
    body: JSON.stringify({ sourceImageId: "00000000-0000-0000-0000-000000000000", prompt: "edit it" }),
  });
  expect(ownRes.status).toBe(404);
});

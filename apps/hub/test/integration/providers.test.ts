import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig, type Config } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { encryptSecret, decryptSecret } from "../../src/crypto/secretbox";
import { deleteProviderSettings, getProviderSettings, upsertProviderSettings } from "../../src/providers/repo";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

// 32 bytes hex-encoded -- a valid MANDO_ENCRYPTION_KEY, matching the
// crypto/secretbox.ts contract exercised in secretbox.test.ts.
const ENCRYPTION_KEY_HEX = "ab".repeat(32);

const config: Config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
  PUBLIC_URL: "http://localhost:8080",
  MANDO_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX,
});

// No MANDO_ENCRYPTION_KEY set -- the feature-disabled path every provider
// route must fall back to.
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

// --- repo-level: encryption round-trip, upsert, delete ---

test("upsertProviderSettings stores the key encrypted (never plaintext) and getProviderSettings' row decrypts back to it", async () => {
  const app = buildApp({ sql, config });
  const { userId } = await registerAndLogin(app, "repo-roundtrip");

  const plainKey = "sk-super-secret-plaintext-value";
  await upsertProviderSettings(sql, userId, {
    baseUrl: "https://1.1.1.1/v1",
    apiKeyEncrypted: encryptSecret(plainKey, config),
    imageModel: "flux-2-klein",
    chatModel: null,
  });

  const row = await getProviderSettings(sql, userId);
  expect(row).not.toBeNull();
  expect(row!.api_key_encrypted).not.toBe(plainKey);
  expect(row!.api_key_encrypted).not.toContain(plainKey);
  expect(decryptSecret(row!.api_key_encrypted, config)).toBe(plainKey);
});

test("upsertProviderSettings on an existing user updates the row rather than inserting a second one", async () => {
  const app = buildApp({ sql, config });
  const { userId } = await registerAndLogin(app, "repo-upsert-update");

  await upsertProviderSettings(sql, userId, {
    baseUrl: "https://a.example.com/v1",
    apiKeyEncrypted: encryptSecret("key-one", config),
    imageModel: null,
    chatModel: null,
  });
  await upsertProviderSettings(sql, userId, {
    baseUrl: "https://b.example.com/v1",
    apiKeyEncrypted: encryptSecret("key-two", config),
    imageModel: "model-two",
    chatModel: "chat-model-two",
  });

  const row = await getProviderSettings(sql, userId);
  expect(row!.base_url).toBe("https://b.example.com/v1");
  expect(row!.image_model).toBe("model-two");
  expect(row!.chat_model).toBe("chat-model-two");
  expect(decryptSecret(row!.api_key_encrypted, config)).toBe("key-two");
});

test("deleteProviderSettings removes the row and reports whether one existed", async () => {
  const app = buildApp({ sql, config });
  const { userId } = await registerAndLogin(app, "repo-delete");

  expect(await deleteProviderSettings(sql, userId)).toBe(false);

  await upsertProviderSettings(sql, userId, {
    baseUrl: "https://x.example.com/v1",
    apiKeyEncrypted: encryptSecret("key", config),
    imageModel: null,
    chatModel: null,
  });
  expect(await deleteProviderSettings(sql, userId)).toBe(true);
  expect(await getProviderSettings(sql, userId)).toBeNull();
});

// --- route-level ---

test("GET /api/v1/provider requires an authenticated session", async () => {
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/provider");
  expect(res.status).toBe(401);
});

test("GET /api/v1/provider with nothing configured reports hasKey false and no key", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "get-empty");

  const res = await app.request("/api/v1/provider", { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ baseUrl: null, imageModel: null, chatModel: null, hasKey: false });
});

test("PUT /api/v1/provider validates the URL, encrypts the key, and GET never returns the key", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "put-then-get");

  const putRes = await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      baseUrl: "https://1.1.1.1/v1",
      apiKey: "sk-real-secret-key",
      imageModel: "flux-2-klein",
      chatModel: "gpt-4o-mini",
    }),
  });
  expect(putRes.status).toBe(200);
  const putBody = await putRes.json();
  expect(JSON.stringify(putBody)).not.toContain("sk-real-secret-key");

  const getRes = await app.request("/api/v1/provider", { headers: { Cookie: cookie } });
  const getBody = await getRes.json();
  expect(getBody).toEqual({
    baseUrl: "https://1.1.1.1/v1",
    imageModel: "flux-2-klein",
    chatModel: "gpt-4o-mini",
    hasKey: true,
  });
  expect(JSON.stringify(getBody)).not.toContain("sk-real-secret-key");

  // The row itself must never contain the plaintext key either -- only its
  // encrypted, decryptable form.
  const row = await getProviderSettings(sql, userId);
  expect(row!.api_key_encrypted).not.toContain("sk-real-secret-key");
  expect(decryptSecret(row!.api_key_encrypted, config)).toBe("sk-real-secret-key");
});

test("PUT /api/v1/provider rejects an SSRF-unsafe base URL and does not persist anything", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "put-unsafe-url");

  const res = await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://169.254.169.254/v1", apiKey: "sk-key" }),
  });
  expect(res.status).toBe(400);

  expect(await getProviderSettings(sql, userId)).toBeNull();
});

test("PUT /api/v1/provider requires an apiKey the first time a provider is configured", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "put-missing-key-first-time");

  const res = await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v1" }),
  });
  expect(res.status).toBe(400);
});

test("PUT /api/v1/provider without apiKey keeps the existing encrypted key while updating other fields", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "put-keep-key");

  await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v1", apiKey: "sk-original-key" }),
  });
  const originalRow = await getProviderSettings(sql, userId);

  const updateRes = await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v2", imageModel: "new-model" }),
  });
  expect(updateRes.status).toBe(200);

  const updatedRow = await getProviderSettings(sql, userId);
  expect(updatedRow!.base_url).toBe("https://1.1.1.1/v2");
  expect(updatedRow!.image_model).toBe("new-model");
  expect(updatedRow!.api_key_encrypted).toBe(originalRow!.api_key_encrypted);
  expect(decryptSecret(updatedRow!.api_key_encrypted, config)).toBe("sk-original-key");
});

test("DELETE /api/v1/provider removes the settings so a subsequent GET reports hasKey false", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "delete-flow");

  await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v1", apiKey: "sk-key" }),
  });

  const deleteRes = await app.request("/api/v1/provider", { method: "DELETE", headers: { Cookie: cookie } });
  expect(deleteRes.status).toBe(200);

  const getRes = await app.request("/api/v1/provider", { headers: { Cookie: cookie } });
  const getBody = await getRes.json();
  expect(getBody.hasKey).toBe(false);
});

test("provider routes return 503 images_disabled for GET/PUT/DELETE when encryption is not configured", async () => {
  const app = buildApp({ sql, config: disabledConfig });
  const { cookie } = await registerAndLogin(app, "disabled-feature");

  const getRes = await app.request("/api/v1/provider", { headers: { Cookie: cookie } });
  expect(getRes.status).toBe(503);
  expect(await getRes.json()).toEqual({ error: "images_disabled" });

  const putRes = await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v1", apiKey: "sk-key" }),
  });
  expect(putRes.status).toBe(503);

  const deleteRes = await app.request("/api/v1/provider", { method: "DELETE", headers: { Cookie: cookie } });
  expect(deleteRes.status).toBe(503);

  const modelsRes = await app.request("/api/v1/provider/models", { headers: { Cookie: cookie } });
  expect(modelsRes.status).toBe(503);
  expect(await modelsRes.json()).toEqual({ error: "images_disabled" });
});

test("PUT /api/v1/provider persists chatModel and GET returns it back", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "chat-model-roundtrip");

  await app.request("/api/v1/provider", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ baseUrl: "https://1.1.1.1/v1", apiKey: "sk-key", chatModel: "gpt-4o-mini" }),
  });

  const row = await getProviderSettings(sql, userId);
  expect(row!.chat_model).toBe("gpt-4o-mini");

  const getRes = await app.request("/api/v1/provider", { headers: { Cookie: cookie } });
  const getBody = await getRes.json();
  expect(getBody.chatModel).toBe("gpt-4o-mini");
  expect(getBody.hasKey).toBe(true);
  expect(JSON.stringify(getBody)).not.toContain("sk-key");
});

// --- GET /api/v1/provider/models ---

type FakeServer = { baseUrl: string; stop(): void };

function startFakeProviderServer(handler: (req: Request) => Promise<Response> | Response): FakeServer {
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  return { baseUrl: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

// Permissive SSRF-guard stub -- same rationale as images.test.ts's
// noopGuard: the real guard (covered on its own in url-guard.test.ts and
// this file's own "unsafe" test below) always and correctly rejects
// loopback/plain-http, which is exactly where these fake servers run.
const noopModelGuard = async () => {};

test("GET /api/v1/provider/models requires an authenticated session", async () => {
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/provider/models");
  expect(res.status).toBe(401);
});

test("GET /api/v1/provider/models returns 400 provider_not_configured when the user has no provider row", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "models-no-provider");

  const res = await app.request("/api/v1/provider/models", { headers: { Cookie: cookie } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "provider_not_configured" });
});

test("GET /api/v1/provider/models proxies the provider's raw model list with a Bearer key and never leaks the key", async () => {
  const fake = startFakeProviderServer((req) => {
    expect(req.method).toBe("GET");
    expect(new URL(req.url).pathname).toBe("/models");
    expect(req.headers.get("authorization")).toBe("Bearer sk-models-key");
    return Response.json({
      data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }, { id: 42 }],
    });
  });

  try {
    const app = buildApp({ sql, config, providerModelsDeps: { assertSafeUrl: noopModelGuard } });
    const { userId, cookie } = await registerAndLogin(app, "models-proxy");
    await upsertProviderSettings(sql, userId, {
      baseUrl: fake.baseUrl,
      apiKeyEncrypted: encryptSecret("sk-models-key", config),
      imageModel: null,
      chatModel: null,
    });

    const res = await app.request("/api/v1/provider/models", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Raw list -- non-chat filtering is left to the client (apps/web),
    // so a non-chat id like the embedding model here still comes through.
    expect(body).toEqual([{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }]);
    expect(JSON.stringify(body)).not.toContain("sk-models-key");
  } finally {
    fake.stop();
  }
});

test("GET /api/v1/provider/models rejects an unsafe provider base URL end to end via the real guard", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "models-unsafe-url");
  // Bypasses PUT's own save-time guard directly at the repo layer to
  // simulate the DNS-rebinding scenario the request-time guard defends
  // against (see images.test.ts's equivalent test for the same rationale).
  await upsertProviderSettings(sql, userId, {
    baseUrl: "https://169.254.169.254/v1",
    apiKeyEncrypted: encryptSecret("sk-key", config),
    imageModel: null,
    chatModel: null,
  });

  const res = await app.request("/api/v1/provider/models", { headers: { Cookie: cookie } });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "provider_unsafe_url" });
});

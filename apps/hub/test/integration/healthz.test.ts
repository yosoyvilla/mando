import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser, findUserByEmail } from "../../src/users/repo";
import { bootstrapAdmin } from "../../src/bootstrap";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

const config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
  PUBLIC_URL: "http://localhost:8080",
});

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueEmail(tag: string) {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

test("GET /healthz returns 200 {status: ok}", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/healthz");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("an unknown non-API route degrades gracefully (SPA fallback or 404) when no web build exists", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/some/client/route");

  // No web build is expected to exist in this test environment (it's
  // produced later, in Phase 5). Either the SPA fallback served
  // index.html (200) or -- more likely here -- it 404s gracefully. What
  // matters is the server doesn't crash or 500.
  expect([200, 404]).toContain(res.status);
});

test("an unknown /api/* route stays a plain 404 and is never masked by the SPA fallback", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/does-not-exist");

  expect(res.status).toBe(404);
});

test("bootstrapAdmin creates the configured admin when absent, and is idempotent", async () => {
  const email = uniqueEmail("bootstrap-admin");
  const adminConfig = loadConfig({
    DATABASE_URL: url,
    COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
    PUBLIC_URL: "http://localhost:8080",
    MANDO_ADMIN_EMAIL: email,
    MANDO_ADMIN_PASSWORD: "hunter2horse",
  });

  await bootstrapAdmin(sql, adminConfig);

  const created = await findUserByEmail(sql, email);
  expect(created).not.toBeNull();
  expect(created.email).toBe(email);
  expect(created.is_admin).toBe(true);

  // Second run must not throw even though the user already exists.
  await expect(bootstrapAdmin(sql, adminConfig)).resolves.toBeUndefined();
});

test("bootstrapAdmin is a no-op when admin env vars are unset", async () => {
  await expect(bootstrapAdmin(sql, config)).resolves.toBeUndefined();
});

test("bootstrapAdmin promotes a pre-existing non-admin account at the configured email to admin", async () => {
  // Upgrade scenario: the account existed (e.g. from before is_admin was
  // introduced) with is_admin still false -- bootstrapAdmin's early-return
  // for "already exists" must not skip promoting it, or a real upgraded
  // deployment's configured admin would stay locked out of
  // admin-gated routes forever.
  const email = uniqueEmail("bootstrap-promote");
  await createUser(sql, email, "some-other-password");
  const before = await findUserByEmail(sql, email);
  expect(before.is_admin).toBe(false);

  const adminConfig = loadConfig({
    DATABASE_URL: url,
    COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
    PUBLIC_URL: "http://localhost:8080",
    MANDO_ADMIN_EMAIL: email,
    MANDO_ADMIN_PASSWORD: "hunter2horse",
  });

  await bootstrapAdmin(sql, adminConfig);

  const after = await findUserByEmail(sql, email);
  expect(after.is_admin).toBe(true);
});

import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
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

// app.request() (no real Bun.serve behind it) can't supply a real
// connection IP, so every request is identified by X-Forwarded-For --
// see middleware/rate-limit.ts's clientIp().
function loginRequest(app: ReturnType<typeof buildApp>, email: string, ip: string) {
  return app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ email, password: "wrong-password-on-purpose" }),
  });
}

test("exceeding the login rate limit returns 429 with a Retry-After header", async () => {
  const email = uniqueEmail("ratelimit-login");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config, rateLimits: { login: { windowMs: 60_000, max: 3 } } });
  const ip = "203.0.113.10";

  for (let i = 0; i < 3; i++) {
    const res = await loginRequest(app, email, ip);
    expect(res.status).toBe(401); // wrong password, but under the limit
  }

  const limited = await loginRequest(app, email, ip);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBeTruthy();
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
});

test("a normal login request rate is never rate-limited", async () => {
  const email = uniqueEmail("ratelimit-normal");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config, rateLimits: { login: { windowMs: 60_000, max: 10 } } });
  const ip = "203.0.113.20";

  for (let i = 0; i < 5; i++) {
    const res = await loginRequest(app, email, ip);
    expect(res.status).toBe(401);
  }
});

test("the login rate limit is keyed per-IP -- two IPs are limited independently", async () => {
  const email = uniqueEmail("ratelimit-perip");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config, rateLimits: { login: { windowMs: 60_000, max: 2 } } });

  // Each IP gets its own budget: two requests from ip-a exhaust its limit,
  // but ip-b (never having made a request yet) is unaffected.
  await loginRequest(app, email, "203.0.113.30");
  await loginRequest(app, email, "203.0.113.30");
  const ipALimited = await loginRequest(app, email, "203.0.113.30");
  expect(ipALimited.status).toBe(429);

  const ipBRes = await loginRequest(app, email, "203.0.113.31");
  expect(ipBRes.status).toBe(401);
});

test("exceeding the pairing/request rate limit returns 429", async () => {
  const app = buildApp({ sql, config, rateLimits: { pairingRequest: { windowMs: 60_000, max: 2 } } });
  const ip = "203.0.113.40";

  function pair() {
    return app.request("/api/v1/pairing/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ machineName: "flood-test" }),
    });
  }

  expect((await pair()).status).toBe(201);
  expect((await pair()).status).toBe(201);
  const limited = await pair();
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBeTruthy();
});

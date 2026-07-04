import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser, findUserByEmail } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
import { verifySecret } from "../../src/auth/password";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);
const config = loadConfig({
  DATABASE_URL: url,
  COOKIE_SECRET: "test-secret",
  PUBLIC_URL: "http://localhost:8080",
});

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueEmail(tag: string) {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

test("login with bad password returns 401", async () => {
  const email = uniqueEmail("badpw");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-password" }),
  });

  expect(res.status).toBe(401);
});

test("login with unknown email returns the same 401 as a bad password", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("unknown"), password: "whatever1" }),
  });

  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.error).not.toMatch(/email/i);
});

test("login with good password sets mando_sess cookie and GET /api/v1/me returns the email", async () => {
  const email = uniqueEmail("goodpw");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config });

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-password" }),
  });
  expect(loginRes.status).toBe(200);
  const loginBody = await loginRes.json();
  expect(loginBody.user.email).toBe(email);

  const setCookieHeader = loginRes.headers.get("set-cookie");
  expect(setCookieHeader).toBeTruthy();
  expect(setCookieHeader).toContain("mando_sess=");
  expect(setCookieHeader).toContain("HttpOnly");
  expect(setCookieHeader).toContain("Secure");
  expect(setCookieHeader).toContain("SameSite=Lax");
  expect(setCookieHeader).toContain("Path=/");

  const cookieValue = setCookieHeader!.split(";")[0];

  const meRes = await app.request("/api/v1/me", {
    headers: { Cookie: cookieValue },
  });
  expect(meRes.status).toBe(200);
  const meBody = await meRes.json();
  expect(meBody.email).toBe(email);
});

test("GET /api/v1/me without a cookie returns 401", async () => {
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/me");
  expect(res.status).toBe(401);
});

test("logout destroys the session so /api/v1/me subsequently returns 401", async () => {
  const email = uniqueEmail("logout");
  await createUser(sql, email, "correct-password");
  const app = buildApp({ sql, config });

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-password" }),
  });
  const cookieValue = loginRes.headers.get("set-cookie")!.split(";")[0];

  const logoutRes = await app.request("/api/v1/auth/logout", {
    method: "POST",
    headers: { Cookie: cookieValue },
  });
  expect(logoutRes.status).toBe(200);

  const meRes = await app.request("/api/v1/me", { headers: { Cookie: cookieValue } });
  expect(meRes.status).toBe(401);
});

// Bootstrap-on-shared-DB strategy: this suite runs against the same
// long-lived Postgres instance as every other hub test file, which by now
// always has users seeded by earlier suites. That makes the "refuse when
// users already exist" path naturally deterministic here -- no setup
// needed, it will always be true. We do NOT truncate the shared `users`
// table (that would break concurrently-run/earlier suites' assumptions).
// To also exercise the happy path safely, we run it inside a Postgres
// transaction that deletes `users`, calls bootstrap, and is always rolled
// back at the end -- other connections never see the uncommitted delete,
// so the shared DB is left untouched regardless of pass/fail.
test("bootstrap refuses to create a second admin when users already exist", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("bootstrap-refuse"), password: "hunter2horse" }),
  });

  expect(res.status).toBe(409);
});

test("bootstrap creates the first admin only when zero users exist (rolled back)", async () => {
  const RollbackMarker = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`delete from users`;
      // buildApp's AppDeps.sql is typed as the top-level `postgres()`
      // client; a transaction handle only implements the shared
      // tagged-template query surface, not the full client type (end(),
      // begin(), etc). Every route we exercise here only issues tagged
      // template queries, so the cast is safe -- this keeps the
      // production `Sql` type contract (shared with already-reviewed
      // 2.1-2.4 code) untouched rather than loosening it repo-wide just
      // for this test's rollback trick.
      const app = buildApp({ sql: tx as unknown as typeof sql, config });

      const email = uniqueEmail("bootstrap-happy");
      const firstRes = await app.request("/api/v1/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "hunter2horse" }),
      });
      expect(firstRes.status).toBe(201);
      const firstBody = await firstRes.json();
      expect(firstBody.user.email).toBe(email);

      const secondRes = await app.request("/api/v1/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: uniqueEmail("bootstrap-second"), password: "hunter2horse" }),
      });
      expect(secondRes.status).toBe(409);

      throw RollbackMarker;
    });
  } catch (e) {
    if (e !== RollbackMarker) throw e;
  }
});

test("bootstrap rejects a password shorter than 8 characters", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("bootstrap-shortpw"), password: "short" }),
  });

  // Body validation runs before the "zero users" check, so this is 400
  // regardless of how many users already exist in the shared DB.
  expect(res.status).toBe(400);
});

test("invite requires an authenticated session", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: uniqueEmail("invitee-noauth") }),
  });

  expect(res.status).toBe(401);
});

test("invite creates a user with a temp password when authenticated", async () => {
  const owner = await createUser(sql, uniqueEmail("inviter"), "correct-password");
  const sessionId = await createSession(sql, owner.id);
  const app = buildApp({ sql, config });

  const inviteeEmail = uniqueEmail("invitee");
  const res = await app.request("/api/v1/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
    body: JSON.stringify({ email: inviteeEmail }),
  });

  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.user.email).toBe(inviteeEmail);
  expect(typeof body.tempPassword).toBe("string");
  expect(body.tempPassword.length).toBeGreaterThan(0);

  const found = await findUserByEmail(sql, inviteeEmail);
  expect(await verifySecret(body.tempPassword, found.password_hash)).toBe(true);
});

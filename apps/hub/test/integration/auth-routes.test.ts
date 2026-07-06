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
  COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
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
  expect(setCookieHeader).toContain("Max-Age=2592000");

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
// long-lived Postgres instance as every other hub test file. We do NOT
// truncate the shared `users` table (that would break concurrently-run/
// earlier suites' assumptions). To also exercise the happy path safely,
// we run it inside a Postgres transaction that deletes `users`, calls
// bootstrap, and is always rolled back at the end -- other connections
// never see the uncommitted delete, so the shared DB is left untouched
// regardless of pass/fail.
test("bootstrap refuses to create a second admin when users already exist", async () => {
  // Explicitly seed a user rather than relying on earlier tests in this
  // file (or other suites) having already inserted one -- that made this
  // test order-coupled and it could pass for the wrong reason (or fail)
  // if run in isolation or in a different order.
  await createUser(sql, uniqueEmail("bootstrap-refuse-precondition"), "password123");
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

test("invite from a non-admin authenticated user returns 403", async () => {
  const nonAdmin = await createUser(sql, uniqueEmail("inviter-nonadmin"), "correct-password");
  const sessionId = await createSession(sql, nonAdmin.id);
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
    body: JSON.stringify({ email: uniqueEmail("invitee-blocked") }),
  });

  expect(res.status).toBe(403);
});

test("invite creates a user with a temp password when the caller is an admin", async () => {
  const owner = await createUser(sql, uniqueEmail("inviter-admin"), "correct-password", { isAdmin: true });
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

test("inviting an email that already exists returns a generic 409, not a 500 or an enumeration signal", async () => {
  const owner = await createUser(sql, uniqueEmail("inviter-admin-dup"), "correct-password", { isAdmin: true });
  const sessionId = await createSession(sql, owner.id);
  const app = buildApp({ sql, config });

  const existingEmail = uniqueEmail("already-registered");
  await createUser(sql, existingEmail, "some-password");

  const res = await app.request("/api/v1/auth/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
    body: JSON.stringify({ email: existingEmail }),
  });

  expect(res.status).toBe(409);
  const body = await res.json();
  // Same neutral message a duplicate-email 409 gets -- nothing here should
  // let a caller distinguish "exists" from any other reason creation failed.
  expect(body.error).not.toMatch(/email/i);
  expect(body.error).not.toMatch(/exist/i);
  expect(body.tempPassword).toBeUndefined();
});

// Same rolled-back-transaction strategy as "bootstrap creates the first
// admin only when zero users exist" above -- POST /api/v1/auth/bootstrap
// only succeeds while zero users exist, which is already false on this
// shared DB by the time this test runs.
test("bootstrap creates the admin with is_admin true (rolled back)", async () => {
  const RollbackMarker = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`delete from users`;
      const app = buildApp({ sql: tx as unknown as typeof sql, config });

      const email = uniqueEmail("bootstrap-is-admin");
      const res = await app.request("/api/v1/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "hunter2horse" }),
      });
      expect(res.status).toBe(201);

      const found = await findUserByEmail(tx as unknown as typeof sql, email);
      expect(found.is_admin).toBe(true);

      throw RollbackMarker;
    });
  } catch (e) {
    if (e !== RollbackMarker) throw e;
  }
});

test("GET /api/v1/me includes isAdmin for an admin and a non-admin", async () => {
  const admin = await createUser(sql, uniqueEmail("me-admin"), "correct-password", { isAdmin: true });
  const plain = await createUser(sql, uniqueEmail("me-plain"), "correct-password");
  const app = buildApp({ sql, config });

  const adminSession = await createSession(sql, admin.id);
  const adminRes = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${adminSession}` } });
  expect(adminRes.status).toBe(200);
  expect((await adminRes.json()).isAdmin).toBe(true);

  const plainSession = await createSession(sql, plain.id);
  const plainRes = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${plainSession}` } });
  expect((await plainRes.json()).isAdmin).toBe(false);
});

test("login response includes isAdmin", async () => {
  const email = uniqueEmail("login-isadmin");
  await createUser(sql, email, "correct-password", { isAdmin: true });
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct-password" }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).user.isAdmin).toBe(true);
});

test("GET /api/v1/users returns all users for an admin", async () => {
  const admin = await createUser(sql, uniqueEmail("list-admin"), "correct-password", { isAdmin: true });
  const other = await createUser(sql, uniqueEmail("list-other"), "correct-password");
  const sessionId = await createSession(sql, admin.id);
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/users", { headers: { Cookie: `mando_sess=${sessionId}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  const ids = body.users.map((u: { id: string }) => u.id);
  expect(ids).toContain(admin.id);
  expect(ids).toContain(other.id);
  const adminRow = body.users.find((u: { id: string }) => u.id === admin.id);
  expect(adminRow.isAdmin).toBe(true);
  expect(typeof adminRow.createdAt).toBe("string");
  expect(adminRow.passwordHash).toBeUndefined();
  expect(adminRow.password_hash).toBeUndefined();
});

test("GET /api/v1/users from a non-admin returns 403", async () => {
  const plain = await createUser(sql, uniqueEmail("list-nonadmin"), "correct-password");
  const sessionId = await createSession(sql, plain.id);
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/users", { headers: { Cookie: `mando_sess=${sessionId}` } });
  expect(res.status).toBe(403);
});

test("GET /api/v1/users without a session returns 401", async () => {
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/users");
  expect(res.status).toBe(401);
});

test("DELETE /api/v1/users/:id refuses when an admin targets their own id", async () => {
  const admin = await createUser(sql, uniqueEmail("del-self"), "correct-password", { isAdmin: true });
  const sessionId = await createSession(sql, admin.id);
  const app = buildApp({ sql, config });
  const res = await app.request(`/api/v1/users/${admin.id}`, {
    method: "DELETE",
    headers: { Cookie: `mando_sess=${sessionId}` },
  });
  expect(res.status).toBe(400);
  // The admin must still exist (and stay logged in) after the refused self-delete.
  const check = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${sessionId}` } });
  expect(check.status).toBe(200);
});

test("DELETE /api/v1/users/:id from an admin deletes another user", async () => {
  const admin = await createUser(sql, uniqueEmail("del-admin"), "correct-password", { isAdmin: true });
  const victim = await createUser(sql, uniqueEmail("del-victim"), "correct-password");
  const sessionId = await createSession(sql, admin.id);
  const app = buildApp({ sql, config });
  const res = await app.request(`/api/v1/users/${victim.id}`, {
    method: "DELETE",
    headers: { Cookie: `mando_sess=${sessionId}` },
  });
  expect(res.status).toBe(200);
  expect(await findUserByEmail(sql, victim.email)).toBeNull();
});

// Last-admin self-erasure guard. MUST use the rolled-back-transaction trick:
// the shared test DB already contains multiple admins from other suites, so
// `admins <= 1` is only ever true inside an isolated `delete from users` tx.
test("DELETE /api/v1/me refuses the last admin while other users exist (rolled back)", async () => {
  const RollbackMarker = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`delete from users`;
      const t = tx as unknown as typeof sql;
      const admin = await createUser(t, uniqueEmail("me-last-admin"), "correct-password", { isAdmin: true });
      await createUser(t, uniqueEmail("me-other"), "correct-password"); // a non-admin remains
      const sessionId = await createSession(t, admin.id);
      const app = buildApp({ sql: t, config });

      const res = await app.request("/api/v1/me", {
        method: "DELETE",
        headers: { Cookie: `mando_sess=${sessionId}` },
      });
      expect(res.status).toBe(400);
      // Admin still present.
      const check = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${sessionId}` } });
      expect(check.status).toBe(200);

      throw RollbackMarker;
    });
  } catch (e) {
    if (e !== RollbackMarker) throw e;
  }
});

test("DELETE /api/v1/me allows a solo admin who is the only user to self-erase (rolled back)", async () => {
  const RollbackMarker = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`delete from users`;
      const t = tx as unknown as typeof sql;
      const admin = await createUser(t, uniqueEmail("me-solo-admin"), "correct-password", { isAdmin: true });
      const sessionId = await createSession(t, admin.id);
      const app = buildApp({ sql: t, config });

      const res = await app.request("/api/v1/me", {
        method: "DELETE",
        headers: { Cookie: `mando_sess=${sessionId}` },
      });
      expect(res.status).toBe(200);
      expect(await findUserByEmail(t, admin.email)).toBeNull();

      throw RollbackMarker;
    });
  } catch (e) {
    if (e !== RollbackMarker) throw e;
  }
});

test("POST /api/v1/me/password changes the password and signs out other sessions", async () => {
  const email = uniqueEmail("pwchange");
  const user = await createUser(sql, email, "old-password-1");
  const currentSession = await createSession(sql, user.id);
  const otherSession = await createSession(sql, user.id);
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${currentSession}` },
    body: JSON.stringify({ currentPassword: "old-password-1", newPassword: "brand-new-password-2" }),
  });
  expect(res.status).toBe(200);

  // Hash actually updated (new password verifies).
  const after = await findUserByEmail(sql, email);
  expect(await verifySecret("brand-new-password-2", after.password_hash)).toBe(true);

  // Current session still valid; the other session was invalidated.
  const meCurrent = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${currentSession}` } });
  expect(meCurrent.status).toBe(200);
  const meOther = await app.request("/api/v1/me", { headers: { Cookie: `mando_sess=${otherSession}` } });
  expect(meOther.status).toBe(401);
});

test("POST /api/v1/me/password rejects a wrong current password without changing anything", async () => {
  const email = uniqueEmail("pwwrong");
  const user = await createUser(sql, email, "correct-current");
  const session = await createSession(sql, user.id);
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${session}` },
    body: JSON.stringify({ currentPassword: "wrong-current", newPassword: "some-new-password" }),
  });
  expect(res.status).toBe(400);
  const after = await findUserByEmail(sql, email);
  expect(await verifySecret("correct-current", after.password_hash)).toBe(true);
});

test("POST /api/v1/me/password rejects a too-short new password and an unchanged password", async () => {
  const email = uniqueEmail("pwvalidate");
  const user = await createUser(sql, email, "correct-current-pw");
  const session = await createSession(sql, user.id);
  const app = buildApp({ sql, config });

  const short = await app.request("/api/v1/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${session}` },
    body: JSON.stringify({ currentPassword: "correct-current-pw", newPassword: "short" }),
  });
  expect(short.status).toBe(400);

  const same = await app.request("/api/v1/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${session}` },
    body: JSON.stringify({ currentPassword: "correct-current-pw", newPassword: "correct-current-pw" }),
  });
  expect(same.status).toBe(400);
});

test("POST /api/v1/me/password without a session returns 401", async () => {
  const app = buildApp({ sql, config });
  const res = await app.request("/api/v1/me/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "x", newPassword: "abcdefgh" }),
  });
  expect(res.status).toBe(401);
});

test("PATCH /api/v1/users/:id promotes and demotes a user", async () => {
  const admin = await createUser(sql, uniqueEmail("role-admin"), "correct-password", { isAdmin: true });
  const target = await createUser(sql, uniqueEmail("role-target"), "correct-password");
  const sessionId = await createSession(sql, admin.id);
  const app = buildApp({ sql, config });

  const promote = await app.request(`/api/v1/users/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
    body: JSON.stringify({ isAdmin: true }),
  });
  expect(promote.status).toBe(200);
  expect((await promote.json()).isAdmin).toBe(true);
  expect((await findUserByEmail(sql, target.email)).is_admin).toBe(true);

  const demote = await app.request(`/api/v1/users/${target.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
    body: JSON.stringify({ isAdmin: false }),
  });
  expect(demote.status).toBe(200);
  expect((await findUserByEmail(sql, target.email)).is_admin).toBe(false);
});

test("PATCH /api/v1/users/:id from a non-admin returns 403 and unknown id returns 404", async () => {
  const plain = await createUser(sql, uniqueEmail("role-nonadmin"), "correct-password");
  const plainSession = await createSession(sql, plain.id);
  const admin = await createUser(sql, uniqueEmail("role-admin2"), "correct-password", { isAdmin: true });
  const adminSession = await createSession(sql, admin.id);
  const app = buildApp({ sql, config });

  const forbidden = await app.request(`/api/v1/users/${admin.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${plainSession}` },
    body: JSON.stringify({ isAdmin: true }),
  });
  expect(forbidden.status).toBe(403);

  const missing = await app.request(`/api/v1/users/00000000-0000-0000-0000-000000000000`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: `mando_sess=${adminSession}` },
    body: JSON.stringify({ isAdmin: true }),
  });
  expect(missing.status).toBe(404);
});

// Last-admin demote guard. MUST use the rolled-back-transaction trick: the
// shared test DB has many admins from other suites, so `admins <= 1` only
// holds inside an isolated `delete from users` tx.
test("PATCH /api/v1/users/:id refuses to demote the last admin (rolled back)", async () => {
  const RollbackMarker = Symbol("rollback");
  try {
    await sql.begin(async (tx) => {
      await tx`delete from users`;
      const t = tx as unknown as typeof sql;
      const admin = await createUser(t, uniqueEmail("last-admin-demote"), "correct-password", { isAdmin: true });
      await createUser(t, uniqueEmail("last-admin-other"), "correct-password"); // a non-admin remains
      const sessionId = await createSession(t, admin.id);
      const app = buildApp({ sql: t, config });

      const res = await app.request(`/api/v1/users/${admin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: `mando_sess=${sessionId}` },
        body: JSON.stringify({ isAdmin: false }),
      });
      expect(res.status).toBe(400);
      expect((await findUserByEmail(t, admin.email)).is_admin).toBe(true);
      throw RollbackMarker;
    });
  } catch (e) {
    if (e !== RollbackMarker) throw e;
  }
});

import { test, expect, beforeAll } from "bun:test";
import type postgres from "postgres";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
import { logAudit } from "../../src/audit";

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

async function loginSessionCookie(userId: string) {
  const sessionId = await createSession(sql, userId);
  return `mando_sess=${sessionId}`;
}

async function latestAuditRow(eventType: string, actorUserId: string) {
  const rows = await sql`
    select event_type, actor_user_id, target, ip
    from audit_log
    where event_type = ${eventType} and actor_user_id = ${actorUserId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

test("a successful login writes a login_success audit row for that user", async () => {
  const app = buildApp({ sql, config });
  const email = uniqueEmail("audit-login-ok");
  const password = "correct-password";
  const user = await createUser(sql, email, password);

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);

  const row = await latestAuditRow("login_success", user.id);
  expect(row).not.toBeNull();
  expect(row!.actor_user_id).toBe(user.id);
});

test("a failed login writes a login_failure audit row with no actor and no identifying target", async () => {
  const app = buildApp({ sql, config });
  const email = uniqueEmail("audit-login-fail");
  await createUser(sql, email, "correct-password");

  const before = await sql`select count(*)::int as count from audit_log where event_type = 'login_failure'`;

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "wrong-password" }),
  });
  expect(res.status).toBe(401);

  const after = await sql`select count(*)::int as count from audit_log where event_type = 'login_failure'`;
  expect(after[0]!.count).toBeGreaterThan(before[0]!.count);

  const latest = await sql`
    select actor_user_id, target from audit_log where event_type = 'login_failure' order by created_at desc limit 1
  `;
  expect(latest[0]!.actor_user_id).toBeNull();
  expect(latest[0]!.target).toBeNull();
});

test("pairing approval writes a pairing_approved audit row with actor=user and target=machine id", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("audit-pairing"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "audit-pairing-machine" }),
  });
  const { code } = await requestRes.json();

  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  expect(approveRes.status).toBe(200);
  const { machineId } = await approveRes.json();

  const row = await latestAuditRow("pairing_approved", owner.id);
  expect(row).not.toBeNull();
  expect(row!.target).toBe(machineId);
});

test("machine revoke writes a machine_revoked audit row with actor=user and target=machine id", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("audit-revoke"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "audit-revoke-machine" }),
  });
  const { code } = await requestRes.json();
  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  const { machineId } = await approveRes.json();

  const revokeRes = await app.request(`/api/v1/machines/${machineId}/revoke`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  expect(revokeRes.status).toBe(200);

  const row = await latestAuditRow("machine_revoked", owner.id);
  expect(row).not.toBeNull();
  expect(row!.target).toBe(machineId);
});

test("self-deletion writes a user_deleted_self audit row, and admin-deletion writes a user_deleted_by_admin row with the deleted id as target", async () => {
  const app = buildApp({ sql, config });

  const selfDeleter = await createUser(sql, uniqueEmail("audit-self-delete"), "correct-password");
  const selfCookie = await loginSessionCookie(selfDeleter.id);
  const beforeSelfDelete = new Date();
  const selfRes = await app.request("/api/v1/me", { method: "DELETE", headers: { Cookie: selfCookie } });
  expect(selfRes.status).toBe(200);

  // Can't filter by actor_user_id here -- the FK's ON DELETE SET NULL
  // already nulled it out as part of the delete that just ran (that's the
  // erasure-preserves-audit-trail design under test elsewhere in this
  // file). A time-bounded existence check is what's actually verifiable
  // post-deletion.
  const selfRows = await sql`
    select id from audit_log where event_type = 'user_deleted_self' and created_at >= ${beforeSelfDelete}
  `;
  expect(selfRows.length).toBeGreaterThanOrEqual(1);

  const admin = await createUser(sql, uniqueEmail("audit-admin-delete"), "correct-password", { isAdmin: true });
  const adminCookie = await loginSessionCookie(admin.id);
  const target = await createUser(sql, uniqueEmail("audit-admin-delete-target"), "correct-password");
  const adminRes = await app.request(`/api/v1/users/${target.id}`, {
    method: "DELETE",
    headers: { Cookie: adminCookie },
  });
  expect(adminRes.status).toBe(200);
  const adminRow = await latestAuditRow("user_deleted_by_admin", admin.id);
  expect(adminRow).not.toBeNull();
  expect(adminRow!.target).toBe(target.id);
});

test("audit survives erasure of the actor: deleting a user leaves their prior audit_log row intact with actor_user_id set to null", async () => {
  const app = buildApp({ sql, config });
  const email = uniqueEmail("audit-survives-erasure");
  const password = "correct-password";
  const user = await createUser(sql, email, password);

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  const rowBefore = await latestAuditRow("login_success", user.id);
  expect(rowBefore).not.toBeNull();
  const [{ id: auditRowId }] = await sql`
    select id from audit_log where event_type = 'login_success' and actor_user_id = ${user.id}
    order by created_at desc limit 1
  `;

  const deleteRes = await app.request("/api/v1/me", { method: "DELETE", headers: { Cookie: cookie } });
  expect(deleteRes.status).toBe(200);

  // The exact login_success row must still exist -- erasure must not
  // destroy the security audit trail -- but its actor is now null since
  // the user row it referenced (ON DELETE SET NULL, not CASCADE) is gone.
  const afterRows = await sql`select actor_user_id from audit_log where id = ${auditRowId}`;
  expect(afterRows.length).toBe(1);
  expect(afterRows[0]!.actor_user_id).toBeNull();
});

test("logAudit swallows write failures instead of throwing", async () => {
  const throwingSql = (() => {
    throw new Error("simulated audit write failure");
  }) as unknown as postgres.ISql;

  await expect(logAudit(throwingSql, { eventType: "login_success" })).resolves.toBeUndefined();
});

test("GET /api/v1/audit requires admin", async () => {
  const app = buildApp({ sql, config });

  const anonRes = await app.request("/api/v1/audit");
  expect(anonRes.status).toBe(401);

  const nonAdmin = await createUser(sql, uniqueEmail("audit-get-nonadmin"), "correct-password");
  const nonAdminCookie = await loginSessionCookie(nonAdmin.id);
  const forbiddenRes = await app.request("/api/v1/audit", { headers: { Cookie: nonAdminCookie } });
  expect(forbiddenRes.status).toBe(403);

  const admin = await createUser(sql, uniqueEmail("audit-get-admin"), "correct-password", { isAdmin: true });
  const adminCookie = await loginSessionCookie(admin.id);
  const okRes = await app.request("/api/v1/audit", { headers: { Cookie: adminCookie } });
  expect(okRes.status).toBe(200);
  const body = await okRes.json();
  expect(Array.isArray(body.events)).toBe(true);
});

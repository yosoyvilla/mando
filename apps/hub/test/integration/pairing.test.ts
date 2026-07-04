import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
import { getMachine } from "../../src/machines/repo";
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

async function loginSessionCookie(userId: string) {
  const sessionId = await createSession(sql, userId);
  return `mando_sess=${sessionId}`;
}

test("full lifecycle: request -> approve -> poll returns approved + token", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("pairing-owner"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "dave-laptop", platform: "darwin" }),
  });
  expect(requestRes.status).toBe(201);
  const requestBody = await requestRes.json();
  expect(requestBody.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(typeof requestBody.expiresAt).toBe("string");

  // Agent polls before approval -- still pending.
  const pendingRes = await app.request(`/api/v1/pairing/status?code=${requestBody.code}`);
  expect(pendingRes.status).toBe(200);
  const pendingBody = await pendingRes.json();
  expect(pendingBody.status).toBe("pending");
  expect(pendingBody.token).toBeUndefined();

  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code: requestBody.code }),
  });
  expect(approveRes.status).toBe(200);
  const approveBody = await approveRes.json();
  expect(typeof approveBody.machineId).toBe("string");
  expect(approveBody.token).toBeUndefined();

  const approvedRes = await app.request(`/api/v1/pairing/status?code=${requestBody.code}`);
  expect(approvedRes.status).toBe(200);
  const approvedBody = await approvedRes.json();
  expect(approvedBody.status).toBe("approved");
  expect(typeof approvedBody.token).toBe("string");

  const machine = await getMachine(sql, approveBody.machineId);
  expect(machine).not.toBeNull();
  expect(machine!.user_id).toBe(owner.id);
  expect(machine!.name).toBe("dave-laptop");
  expect(machine!.platform).toBe("darwin");

  const [tokenRow] = await sql`select token_hash from machine_tokens where machine_id = ${approveBody.machineId}`;
  expect(await verifySecret(approvedBody.token, tokenRow.token_hash)).toBe(true);
});

test("approving an expired code is rejected", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("pairing-expired"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "expired-machine" }),
  });
  const { code } = await requestRes.json();

  await sql`update pairing_requests set expires_at = now() - interval '1 minute' where code = ${code}`;

  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  expect(approveRes.status).toBe(410);
});

test("approving the same code twice is rejected on the second attempt", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("pairing-double"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "double-approve-machine" }),
  });
  const { code } = await requestRes.json();

  const firstApprove = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  expect(firstApprove.status).toBe(200);

  const secondApprove = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  expect(secondApprove.status).toBe(409);
});

test("approving an unknown code returns 404", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("pairing-unknown"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const res = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code: "ZZZZ-ZZZZ" }),
  });
  expect(res.status).toBe(404);
});

test("approve requires an authenticated session", async () => {
  const app = buildApp({ sql, config });

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "noauth-machine" }),
  });
  const { code } = await requestRes.json();

  const res = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(res.status).toBe(401);
});

test("polling an unknown code returns 404", async () => {
  const app = buildApp({ sql, config });

  const res = await app.request("/api/v1/pairing/status?code=NOPE-NOPE");
  expect(res.status).toBe(404);
});

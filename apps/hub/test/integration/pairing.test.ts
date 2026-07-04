import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
import { getMachine, findMachineByToken, revokeMachine } from "../../src/machines/repo";
import { verifySecret } from "../../src/auth/password";
import { approvePairing } from "../../src/pairing/service";

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

// Runs a full request -> approve -> poll cycle over HTTP and returns the
// minted machine id + plaintext token, so tests that only care about what
// happens *after* pairing don't have to repeat the whole flow inline.
async function pairAndApprove(app: ReturnType<typeof buildApp>, cookie: string, machineName: string) {
  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName }),
  });
  const { code } = await requestRes.json();

  const approveRes = await app.request("/api/v1/pairing/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ code }),
  });
  const { machineId } = await approveRes.json();

  const pollRes = await app.request(`/api/v1/pairing/status?code=${code}`);
  const { token } = await pollRes.json();

  return { code, machineId, token: token as string };
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

  // approvedBody.token is the `<tokenId>.<secret>` composite (see
  // machines/repo.ts findMachineByToken) -- only the secret half is
  // argon2-hashed, so verify against that half.
  const [, secret] = approvedBody.token.split(/\.(.*)/s);
  const [tokenRow] = await sql`select token_hash from machine_tokens where machine_id = ${approveBody.machineId}`;
  expect(await verifySecret(secret, tokenRow.token_hash)).toBe(true);
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

test("findMachineByToken resolves a paired machine's plaintext token and rejects garbage", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("find-by-token"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const { machineId, token } = await pairAndApprove(app, cookie, "find-by-token-machine");

  const found = await findMachineByToken(sql, token);
  expect(found).not.toBeNull();
  expect(found!.id).toBe(machineId);

  // No dot at all -- can't even split into id/secret halves.
  const notFound = await findMachineByToken(sql, "not-a-real-token");
  expect(notFound).toBeNull();
});

test("findMachineByToken rejects a malformed token without throwing", async () => {
  // Has a dot, but the id half isn't a valid uuid -- the where-clause's
  // implicit uuid cast would throw in postgres if this weren't caught.
  // bun's test runner already tracks pending `expect(...).resolves`
  // assertions itself before deciding pass/fail, so this would still fail
  // correctly even unawaited -- but awaiting keeps the assertion ordered
  // with the rest of the test body and avoids relying on that runner
  // behavior.
  await expect(findMachineByToken(sql, "not-a-uuid.some-secret")).resolves.toBeNull();

  // A dot with nothing after it (empty secret half) is also malformed.
  await expect(findMachineByToken(sql, "00000000-0000-0000-0000-000000000000.")).resolves.toBeNull();
});

test("revokeMachine invalidates the machine's token and marks it revoked", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("revoke-machine"), "correct-password");
  const cookie = await loginSessionCookie(owner.id);

  const { machineId, token } = await pairAndApprove(app, cookie, "revoke-machine-target");

  // Sanity check: the token resolves before revocation.
  expect(await findMachineByToken(sql, token)).not.toBeNull();

  await revokeMachine(sql, machineId);

  expect(await findMachineByToken(sql, token)).toBeNull();

  const machine = await getMachine(sql, machineId);
  expect(machine).not.toBeNull();
  expect(machine!.revoked_at).not.toBeNull();
});

test("concurrent approvePairing calls for the same code: exactly one succeeds", async () => {
  const app = buildApp({ sql, config });
  const owner = await createUser(sql, uniqueEmail("pairing-race"), "correct-password");

  const requestRes = await app.request("/api/v1/pairing/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName: "race-machine" }),
  });
  const { code } = await requestRes.json();

  const results = await Promise.allSettled([
    approvePairing(sql, owner.id, code),
    approvePairing(sql, owner.id, code),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);

  // Only the winning approve's machine should exist -- the loser's
  // transaction must have rolled back the machine/token it minted.
  const machines = await sql`select id from machines where user_id = ${owner.id}`;
  expect(machines.length).toBe(1);
});

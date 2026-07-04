import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { createUser } from "../../src/users/repo";
import { createSession } from "../../src/auth/session";
import { createMachine, insertMachineToken } from "../../src/machines/repo";
import { createPairingRequest, approvePairing, sweepPendingTokens } from "../../src/pairing/service";
import { runRetention } from "../../src/retention";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

beforeAll(async () => {
  await runMigrations(sql);
});

function uniqueEmail(tag: string) {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

// This suite runs against the shared long-lived Postgres instance other
// test files also use (no per-file truncation -- see users.test.ts's
// convention). runRetention's returned counts can therefore include rows
// left over from other suites running concurrently, so assertions below
// check specific fixture rows by id/code rather than asserting the
// returned summary equals an exact number.

test("runRetention deletes an expired session and leaves an active one", async () => {
  const user = await createUser(sql, uniqueEmail("retention-session"), "correct-password");
  const expiredSessionId = await createSession(sql, user.id);
  await sql`update user_sessions set expires_at = now() - interval '1 day' where id = ${expiredSessionId}`;
  const activeSessionId = await createSession(sql, user.id);

  const summary = await runRetention(sql);
  expect(summary.sessionsDeleted).toBeGreaterThanOrEqual(1);

  expect((await sql`select id from user_sessions where id = ${expiredSessionId}`).length).toBe(0);
  expect((await sql`select id from user_sessions where id = ${activeSessionId}`).length).toBe(1);
});

test("runRetention deletes expired and consumed pairing_requests, leaves a pending one", async () => {
  const user = await createUser(sql, uniqueEmail("retention-pairing"), "correct-password");

  const { code: pendingCode } = await createPairingRequest(sql, { machineName: "pending-machine" });

  const { code: expiredCode } = await createPairingRequest(sql, { machineName: "expired-machine" });
  await sql`update pairing_requests set expires_at = now() - interval '1 minute' where code = ${expiredCode}`;

  const { code: consumedCode } = await createPairingRequest(sql, { machineName: "consumed-machine" });
  await approvePairing(sql, user.id, consumedCode);

  const summary = await runRetention(sql);
  expect(summary.pairingsDeleted).toBeGreaterThanOrEqual(2);

  expect((await sql`select code from pairing_requests where code = ${expiredCode}`).length).toBe(0);
  expect((await sql`select code from pairing_requests where code = ${consumedCode}`).length).toBe(0);
  expect((await sql`select code from pairing_requests where code = ${pendingCode}`).length).toBe(1);
});

test("runRetention purges machine_tokens revoked past the retention window, keeps recent revocations and live tokens", async () => {
  const user = await createUser(sql, uniqueEmail("retention-tokens"), "correct-password");
  const machine = await createMachine(sql, { userId: user.id, name: "retention-machine" });

  const oldTokenId = await insertMachineToken(sql, { machineId: machine.id, tokenHash: "hash-old" });
  await sql`update machine_tokens set revoked_at = now() - interval '40 days' where id = ${oldTokenId}`;

  const recentTokenId = await insertMachineToken(sql, { machineId: machine.id, tokenHash: "hash-recent" });
  await sql`update machine_tokens set revoked_at = now() - interval '1 day' where id = ${recentTokenId}`;

  const liveTokenId = await insertMachineToken(sql, { machineId: machine.id, tokenHash: "hash-live" });

  const summary = await runRetention(sql);
  expect(summary.tokensDeleted).toBeGreaterThanOrEqual(1);

  expect((await sql`select id from machine_tokens where id = ${oldTokenId}`).length).toBe(0);
  expect((await sql`select id from machine_tokens where id = ${recentTokenId}`).length).toBe(1);
  expect((await sql`select id from machine_tokens where id = ${liveTokenId}`).length).toBe(1);
});

test("runRetention respects a custom tokenRetentionWindowMs", async () => {
  const user = await createUser(sql, uniqueEmail("retention-window"), "correct-password");
  const machine = await createMachine(sql, { userId: user.id, name: "retention-window-machine" });

  const tokenId = await insertMachineToken(sql, { machineId: machine.id, tokenHash: "hash-window" });
  await sql`update machine_tokens set revoked_at = now() - interval '2 hours' where id = ${tokenId}`;

  // A 1-hour window makes a token revoked 2 hours ago eligible for purge,
  // even though it's well inside the 30-day default.
  await runRetention(sql, { tokenRetentionWindowMs: 60 * 60 * 1000 });

  expect((await sql`select id from machine_tokens where id = ${tokenId}`).length).toBe(0);
});

test("sweepPendingTokens removes the in-memory pending-token entry created by approvePairing and reports the count", async () => {
  const user = await createUser(sql, uniqueEmail("retention-pendingtokens"), "correct-password");
  const { code } = await createPairingRequest(sql, { machineName: "pending-sweep-machine" });
  await approvePairing(sql, user.id, code);

  // approvePairing stashed a plaintext token under `code` in
  // pairing/service.ts's module-scope pendingTokens map -- sweepPendingTokens
  // is the only way to drop it without going through the normal
  // poll-once-then-clear path (pollPairing).
  expect(sweepPendingTokens([code])).toBe(1);
  // Already gone -- a second sweep for the same code finds nothing.
  expect(sweepPendingTokens([code])).toBe(0);
});

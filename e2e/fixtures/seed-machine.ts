// Seeds a real machine + machine token directly through the hub's own repo
// layer, bypassing the interactive pairing flow (request code -> approve in
// UI -> poll) entirely. This is the same shortcut apps/hub's own
// tunnel.test.ts integration suite takes ("Seeds a machine + plaintext
// token directly against the repo layer, bypassing the pairing HTTP flow")
// -- reusing it here keeps the token format (`<tokenId>.<secret>`, argon2id
// hash) byte-for-byte identical to what approvePairing() mints, so nothing
// downstream (findMachineByToken, the tunnel hello handshake) needs a
// special case for e2e-seeded machines.
//
// These are relative imports into apps/hub/src rather than a workspace
// dependency on `@mando/hub` -- e2e is deliberately NOT a bun workspace
// member (see task-8.1-report.md for why), so it has no node_modules of its
// own for hub's dependencies (postgres, zod). That's fine: Node/Bun resolve
// each bare specifier relative to the *file* doing the importing, not the
// entry script, so apps/hub/src/db/client.ts's own
// `import postgres from "postgres"` still resolves through
// apps/hub/node_modules regardless of who imports client.ts.
//
// IMPORTANT: this module must only ever be imported from a real Bun
// process. `../auth/password.ts` (pulled in transitively through
// machines/repo.ts) does `Bun.password.hash(...)` at module-eval time, so
// merely importing this file under Node throws `ReferenceError: Bun is not
// defined` -- it never even gets to calling anything. Playwright's own
// runner executes global-setup.ts (and everything it imports directly)
// under Node even when invoked via `bunx playwright test` (see
// task-8.1-report.md, "Node vs Bun"), so global-setup.ts does NOT import
// this file directly -- it shells out to scripts/seed-machine.bun.ts (a
// genuine `bun` subprocess) instead, which imports this module safely.
import { getDb } from "../../apps/hub/src/db/client";
import { createMachine, insertMachineToken } from "../../apps/hub/src/machines/repo";
import { hashSecret } from "../../apps/hub/src/auth/password";
import { findUserByEmail } from "../../apps/hub/src/users/repo";

export interface SeededMachine {
  machineId: string;
  token: string;
}

// Looks up the admin user bootstrapped by the hub's own startup (see
// apps/hub/src/bootstrap.ts, driven by MANDO_ADMIN_EMAIL/PASSWORD) and
// mints a machine + token owned by that user, so it shows up in
// `GET /api/v1/machines` once an admin session is logged in -- exactly
// like a real paired machine would.
export async function seedMachine(
  databaseUrl: string,
  adminEmail: string,
  machineName: string,
): Promise<SeededMachine> {
  const sql = getDb(databaseUrl);

  const owner = await findUserByEmail(sql, adminEmail);
  if (!owner) {
    throw new Error(
      `seedMachine: no user found for ${adminEmail} -- hub must bootstrap the admin before seeding runs`,
    );
  }

  const machine = await createMachine(sql, { userId: owner.id as string, name: machineName });
  const secret = `e2e_${crypto.randomUUID()}`;
  const tokenId = await insertMachineToken(sql, {
    machineId: machine.id,
    tokenHash: await hashSecret(secret),
  });

  return { machineId: machine.id, token: `${tokenId}.${secret}` };
}

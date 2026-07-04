import type postgres from "postgres";
import type { Machine } from "../auth/middleware";
import { verifySecret } from "../auth/password";

type Sql = ReturnType<typeof postgres>;

export async function createMachine(
  sql: Sql,
  input: { userId: string; name: string; platform?: string | null },
): Promise<Machine> {
  const rows = await sql`
    insert into machines (user_id, name, platform)
    values (${input.userId}, ${input.name}, ${input.platform ?? null})
    returning *
  `;
  return rows[0] as Machine;
}

export async function listMachines(sql: Sql, userId: string): Promise<Machine[]> {
  const rows = await sql`select * from machines where user_id = ${userId} order by created_at desc`;
  return rows as unknown as Machine[];
}

export async function getMachine(sql: Sql, id: string): Promise<Machine | null> {
  const rows = await sql`select * from machines where id = ${id}`;
  return (rows[0] as Machine) ?? null;
}

export async function revokeMachine(sql: Sql, id: string): Promise<void> {
  // Both updates must land together -- a machine that's revoked but whose
  // tokens are still live (or vice versa) would let a "revoked" machine
  // keep authenticating over an existing tunnel connection.
  await sql.begin(async (tx) => {
    await tx`update machines set revoked_at = now() where id = ${id} and revoked_at is null`;
    await tx`update machine_tokens set revoked_at = now() where machine_id = ${id} and revoked_at is null`;
  });
}

export async function insertMachineToken(
  sql: Sql,
  input: { machineId: string; tokenHash: string },
): Promise<void> {
  await sql`insert into machine_tokens (machine_id, token_hash) values (${input.machineId}, ${input.tokenHash})`;
}

// Tokens are stored as argon2 hashes (never plaintext), so there is no
// column to equality-match the presented token against. Instead we scope
// to non-revoked tokens on non-revoked machines (the candidate set an
// active agent connection could possibly belong to) and run verifySecret
// against each hash until one matches. This is O(active machines) per
// lookup, which is the accepted tradeoff for not persisting recoverable
// secrets -- fine at the fleet sizes this hub is designed for (single
// user/team, not a multi-tenant SaaS).
export async function findMachineByToken(sql: Sql, token: string): Promise<Machine | null> {
  const rows = await sql`
    select m.*, t.token_hash as token_hash
    from machine_tokens t
    join machines m on m.id = t.machine_id
    where t.revoked_at is null and m.revoked_at is null
  `;

  for (const row of rows) {
    if (await verifySecret(token, row.token_hash as string)) {
      const { token_hash, ...machine } = row as Machine & { token_hash: string };
      return machine as Machine;
    }
  }
  return null;
}

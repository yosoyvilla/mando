import type postgres from "postgres";
import type { Machine } from "../auth/middleware";
import { verifySecret } from "../auth/password";

type Sql = ReturnType<typeof postgres>;
// Accepts either a top-level connection or a transaction handle (the `tx`
// passed into a sql.begin(...) callback) -- callers that need these queries
// to participate in a larger transaction pass `tx` through here.
type Executor = postgres.ISql;

export async function createMachine(
  sql: Executor,
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

// Persists the directory `mando connect` was run from (see @mando/protocol's
// HelloFrame.payload.connectDirectory) onto the machine row, so
// machines/routes.ts's serializeMachine() can expose it to the web UI for
// scoping opencode sessions. Called from tunnel/ws.ts's handleHello on
// every hello, not just the first -- the same machine can reconnect after
// `mando connect` was re-run from a different directory, and this column
// has no history, only "most recently seen". The caller (handleHello) only
// invokes this when the incoming hello actually carries a connectDirectory
// -- an old agent build that omits the field leaves the existing value on
// the row untouched rather than clobbering it back to null.
export async function setConnectDirectory(sql: Sql, id: string, connectDirectory: string): Promise<void> {
  await sql`update machines set connect_directory = ${connectDirectory} where id = ${id}`;
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

// Returns the new row's id, which becomes the lookup prefix embedded in
// the plaintext token handed back to the caller (see findMachineByToken).
export async function insertMachineToken(
  sql: Executor,
  input: { machineId: string; tokenHash: string },
): Promise<string> {
  const rows = await sql`
    insert into machine_tokens (machine_id, token_hash)
    values (${input.machineId}, ${input.tokenHash})
    returning id
  `;
  return rows[0]!.id as string;
}

// Plaintext tokens are `<tokenId>.<secret>`, where tokenId is the
// machine_tokens primary key. That lets lookup go straight to the
// indexed row by id -- O(1) -- instead of scanning every non-revoked
// token and running argon2 against each one. Only the secret half is
// ever argon2-verified (exactly once per call), since the tokenId half
// is just a lookup key, not a credential.
export async function findMachineByToken(sql: Sql, token: string): Promise<Machine | null> {
  const dotIndex = token.indexOf(".");
  if (dotIndex <= 0 || dotIndex === token.length - 1) return null; // malformed: no id or no secret half

  const tokenId = token.slice(0, dotIndex);
  const secret = token.slice(dotIndex + 1);

  try {
    const rows = await sql`
      select m.*, t.token_hash as token_hash
      from machine_tokens t
      join machines m on m.id = t.machine_id
      where t.id = ${tokenId} and t.revoked_at is null and m.revoked_at is null
    `;
    const row = rows[0];
    if (!row) return null;

    if (!(await verifySecret(secret, row.token_hash as string))) return null;

    const { token_hash, ...machine } = row as Machine & { token_hash: string };
    return machine as Machine;
  } catch {
    // A malformed tokenId (e.g. not a valid uuid) makes postgres throw on
    // the implicit cast in the where-clause -- treat that the same as
    // "not found" rather than letting it bubble into a 500.
    return null;
  }
}

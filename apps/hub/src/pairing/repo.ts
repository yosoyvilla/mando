import type postgres from "postgres";

// postgres.ISql covers both a top-level connection and a transaction handle
// (the `tx` passed into a sql.begin(...) callback) -- consumePairingRequest
// is called with `tx` so it can share a transaction with the machine/token
// inserts in approvePairing.
type Sql = postgres.ISql;

export type PairingRequestRow = {
  code: string;
  machine_name: string;
  platform: string | null;
  user_id: string | null;
  machine_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

export async function insertPairingRequest(
  sql: Sql,
  input: { code: string; machineName: string; platform: string | null; expiresAt: Date },
): Promise<void> {
  await sql`
    insert into pairing_requests (code, machine_name, platform, expires_at)
    values (${input.code}, ${input.machineName}, ${input.platform}, ${input.expiresAt})
  `;
}

export async function findPairingRequestByCode(sql: Sql, code: string): Promise<PairingRequestRow | null> {
  const rows = await sql`select * from pairing_requests where code = ${code}`;
  return (rows[0] as PairingRequestRow) ?? null;
}

// Atomic: the `consumed_at is null` guard means only one concurrent caller
// can win this update for a given code. Callers must check the returned
// row count -- zero rows means another request already consumed it.
export async function consumePairingRequest(
  sql: Sql,
  code: string,
  userId: string,
  machineId: string,
): Promise<boolean> {
  const rows = await sql`
    update pairing_requests
    set consumed_at = now(), user_id = ${userId}, machine_id = ${machineId}
    where code = ${code} and consumed_at is null
    returning code
  `;
  return rows.length > 0;
}

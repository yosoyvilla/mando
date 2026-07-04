import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

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

export async function consumePairingRequest(
  sql: Sql,
  code: string,
  userId: string,
  machineId: string,
): Promise<void> {
  await sql`
    update pairing_requests
    set consumed_at = now(), user_id = ${userId}, machine_id = ${machineId}
    where code = ${code}
  `;
}

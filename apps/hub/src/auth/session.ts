import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function randomSessionId(): string {
  // Two concatenated random UUIDs (without dashes) give a 64-hex-char,
  // cryptographically random, unguessable session id.
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

export async function createSession(sql: Sql, userId: string): Promise<string> {
  const id = randomSessionId();
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);
  await sql`insert into user_sessions (id, user_id, expires_at) values (${id}, ${userId}, ${expiresAt})`;
  return id;
}

export async function readSession(sql: Sql, id: string): Promise<{ userId: string } | null> {
  const rows = await sql`select user_id, expires_at from user_sessions where id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { userId: row.user_id as string };
}

export async function destroySession(sql: Sql, id: string): Promise<void> {
  await sql`delete from user_sessions where id = ${id}`;
}

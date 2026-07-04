import type postgres from "postgres";
import { hashSecret } from "../auth/password";

export type User = { id: string; email: string; is_admin: boolean };
type Sql = ReturnType<typeof postgres>;

export async function createUser(
  sql: Sql,
  email: string,
  password: string,
  options?: { isAdmin?: boolean },
): Promise<User> {
  const hash = await hashSecret(password);
  const isAdmin = options?.isAdmin ?? false;
  const rows = await sql`
    insert into users (email, password_hash, is_admin)
    values (${email}, ${hash}, ${isAdmin})
    returning id, email, is_admin
  `;
  return rows[0] as User;
}

export async function findUserByEmail(sql: Sql, email: string) {
  const rows = await sql`select id, email, password_hash, is_admin from users where email = ${email}`;
  return rows[0] ?? null;
}

export async function findUserById(sql: Sql, id: string): Promise<User | null> {
  const rows = await sql`select id, email, is_admin from users where id = ${id}`;
  return (rows[0] as User) ?? null;
}

// Hard-deletes the user row. machines/machine_tokens/user_sessions/
// pairing_requests all FK to users with ON DELETE CASCADE (see
// migrations/001_init.sql), so this one delete is what actually erases a
// user's data for GDPR Art.17 / CCPA purposes -- callers (users/routes.ts)
// are responsible for closing any live tunnels first, since a cascaded row
// disappearing doesn't drop an already-open in-memory Registry connection.
// Returns whether a row was actually deleted, so callers can 404 on a
// nonexistent id instead of silently no-op'ing -- same `returning` +
// row-count pattern as pairing/repo.ts's consumePairingRequest.
export async function deleteUser(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql`delete from users where id = ${userId} returning id`;
  return rows.length > 0;
}

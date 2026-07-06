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

export type AdminUserRow = { id: string; email: string; is_admin: boolean; created_at: string };

// Lists every user for the admin user-management page. Ordered oldest-first
// so the bootstrap admin sorts to the top and the list is stable across
// calls. Never selects password_hash -- this feeds a client response.
export async function listUsers(sql: Sql): Promise<AdminUserRow[]> {
  const rows = await sql`
    select id, email, is_admin, created_at
    from users
    order by created_at asc
  `;
  // The postgres driver parses timestamptz columns into JS Date objects,
  // not strings -- normalize to ISO strings here so AdminUserRow's
  // `created_at: string` contract holds for callers that use this value
  // directly (not just ones that round-trip it through JSON, where Date's
  // toJSON would paper over the mismatch).
  return rows.map((r) => ({
    id: r.id as string,
    email: r.email as string,
    is_admin: r.is_admin as boolean,
    created_at: (r.created_at as Date).toISOString(),
  }));
}

// Total user count and how many of them are admins, in one query -- used by
// the DELETE /api/v1/me last-admin guard to decide whether a self-erasure
// would strand the instance with users but no admin.
export async function countUsersAndAdmins(sql: Sql): Promise<{ total: number; admins: number }> {
  const [row] = await sql`
    select count(*)::int as total,
           count(*) filter (where is_admin)::int as admins
    from users
  `;
  return { total: row.total as number, admins: row.admins as number };
}

// Reads only the password hash for one user (by id), for the change-password
// re-auth check. Kept separate from findUserById, which never selects the
// hash so its User result can be handed to clients safely.
export async function getPasswordHash(sql: Sql, userId: string): Promise<string | null> {
  const rows = await sql`select password_hash from users where id = ${userId}`;
  return (rows[0]?.password_hash as string) ?? null;
}

export async function updatePasswordHash(sql: Sql, userId: string, hash: string): Promise<boolean> {
  const rows = await sql`update users set password_hash = ${hash} where id = ${userId} returning id`;
  return rows.length > 0;
}

export async function setUserAdmin(sql: Sql, userId: string, isAdmin: boolean): Promise<boolean> {
  const rows = await sql`update users set is_admin = ${isAdmin} where id = ${userId} returning id`;
  return rows.length > 0;
}

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

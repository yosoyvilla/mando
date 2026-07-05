import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import type postgres from "postgres";
import { readSession } from "./session";
import { findUserById } from "../users/repo";

type Sql = ReturnType<typeof postgres>;

export type Machine = {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  last_seen_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  connect_directory: string | null;
};

export type AuthVariables = {
  userId: string;
  machine: Machine;
};

const SESSION_COOKIE = "mando_sess";

export function requireUser(sql: Sql): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) return c.json({ error: "unauthorized" }, 401);

    const session = await readSession(sql, sessionId);
    if (!session) return c.json({ error: "unauthorized" }, 401);

    c.set("userId", session.userId);
    await next();
  };
}

// Must run after requireUser (needs c.get("userId") already set). Gates
// admin-only routes -- currently just POST /api/v1/auth/invite, which
// otherwise lets any authenticated user mint new accounts (see
// users/routes.ts). A missing/deleted user (session outlived the account)
// folds into the same 403 as "not an admin" rather than a separate error,
// since there's nothing actionable a caller can do differently either way.
export function requireAdmin(sql: Sql): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const user = await findUserById(sql, c.get("userId"));
    if (!user?.is_admin) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

export function requireMachineOwnership(sql: Sql): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "not found" }, 404);

    let machine: Machine | undefined;
    try {
      const rows = await sql`select * from machines where id = ${id}`;
      machine = rows[0] as Machine | undefined;
    } catch (error) {
      // Any DB error here (including a Postgres uuid-cast failure on a
      // malformed :id) must fold into the same 404 as a nonexistent
      // machine -- otherwise a malformed id would leak a 500 and let an
      // attacker distinguish "not valid" from "not yours"/"doesn't exist".
      // Still log it (no secrets in this error -- just the DB driver's
      // failure reason) so a transient DB outage shows up somewhere
      // instead of silently looking like a wave of 404s.
      console.error("requireMachineOwnership: machine lookup failed", error);
      return c.json({ error: "not found" }, 404);
    }
    const userId = c.get("userId");

    if (!machine || machine.user_id !== userId) {
      return c.json({ error: "not found" }, 404);
    }

    c.set("machine", machine);
    await next();
  };
}

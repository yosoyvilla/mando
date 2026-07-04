import type postgres from "postgres";
import type { Config } from "./config";
import { createUser, findUserByEmail } from "./users/repo";
import { logAudit } from "./audit";

type Sql = ReturnType<typeof postgres>;

// Env-based admin bootstrap, run once at server startup (src/index.ts).
// This is distinct from the POST /api/v1/auth/bootstrap HTTP endpoint
// (users/routes.ts), which only refuses when *any* user already exists.
// Here we key off the specific configured email, so re-running this on
// every restart is safe even after other users have been invited.
export async function bootstrapAdmin(sql: Sql, config: Config): Promise<void> {
  if (!config.adminEmail || !config.adminPassword) return;

  const existing = await findUserByEmail(sql, config.adminEmail);
  if (existing) {
    // Upgrade path: a hub that ran before is_admin existed (or before this
    // account was ever granted it) has this row already, with is_admin
    // defaulted to false by migrations/002_add_user_is_admin.sql. Without
    // this, an existing deployment's configured admin would silently stay
    // a non-admin forever after upgrading -- unable to use the now
    // admin-gated POST /api/v1/auth/invite -- even though it's the one
    // account this env config designates as the admin.
    if (!existing.is_admin) {
      await sql`update users set is_admin = true where id = ${existing.id}`;
    }
    return;
  }

  try {
    const admin = await createUser(sql, config.adminEmail, config.adminPassword, { isAdmin: true });
    // No IP here -- this runs at process startup, not inside an HTTP
    // request, so there's no client to attribute it to.
    await logAudit(sql, { eventType: "bootstrap_admin", actorUserId: admin.id });
  } catch (err) {
    // Unique constraint race: something else (a concurrent boot, or the
    // HTTP bootstrap endpoint) created this exact email between our check
    // and our insert. The desired end state -- the admin exists -- still
    // holds, so treat it as success rather than crashing startup.
    const createdConcurrently = await findUserByEmail(sql, config.adminEmail);
    if (!createdConcurrently) throw err;
  }
}

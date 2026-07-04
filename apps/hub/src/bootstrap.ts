import type postgres from "postgres";
import type { Config } from "./config";
import { createUser, findUserByEmail } from "./users/repo";

type Sql = ReturnType<typeof postgres>;

// Env-based admin bootstrap, run once at server startup (src/index.ts).
// This is distinct from the POST /api/v1/auth/bootstrap HTTP endpoint
// (users/routes.ts), which only refuses when *any* user already exists.
// Here we key off the specific configured email, so re-running this on
// every restart is safe even after other users have been invited.
export async function bootstrapAdmin(sql: Sql, config: Config): Promise<void> {
  if (!config.adminEmail || !config.adminPassword) return;

  const existing = await findUserByEmail(sql, config.adminEmail);
  if (existing) return;

  try {
    await createUser(sql, config.adminEmail, config.adminPassword);
  } catch (err) {
    // Unique constraint race: something else (a concurrent boot, or the
    // HTTP bootstrap endpoint) created this exact email between our check
    // and our insert. The desired end state -- the admin exists -- still
    // holds, so treat it as success rather than crashing startup.
    const createdConcurrently = await findUserByEmail(sql, config.adminEmail);
    if (!createdConcurrently) throw err;
  }
}

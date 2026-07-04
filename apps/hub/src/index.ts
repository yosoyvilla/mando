import { loadConfig } from "./config";
import { getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { buildApp, websocket } from "./app";
import { bootstrapAdmin } from "./bootstrap";

// Real server entry point. Everything here is also exercised piecemeal by
// integration tests via buildApp() directly -- this file only wires those
// pieces together and calls Bun.serve, so it's intentionally thin.
if (import.meta.main) {
  const config = loadConfig(process.env);
  const sql = getDb(config.databaseUrl);

  await runMigrations(sql);
  await bootstrapAdmin(sql, config);

  const app = buildApp({ sql, config });
  const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket });

  // No secrets here -- just where we're listening.
  console.log(`mando hub listening on http://localhost:${server.port}`);
}

import { loadConfig, type Config } from "./config";
import { getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { buildApp, websocket, type AppDeps } from "./app";
import { bootstrapAdmin } from "./bootstrap";
import { DEFAULT_RATE_LIMITS } from "./middleware/rate-limit";

// Maps Config's optional MANDO_RATE_LIMIT_*_MAX env overrides onto
// buildApp's rateLimits deps, keeping DEFAULT_RATE_LIMITS' window sizes and
// only swapping `max` when an operator explicitly set one.
function rateLimitsFromConfig(config: Config): AppDeps["rateLimits"] {
  return {
    login: config.rateLimitLoginMax
      ? { ...DEFAULT_RATE_LIMITS.login, max: config.rateLimitLoginMax }
      : undefined,
    pairingRequest: config.rateLimitPairingMax
      ? { ...DEFAULT_RATE_LIMITS.pairingRequest, max: config.rateLimitPairingMax }
      : undefined,
    pairingStatus: config.rateLimitPairingMax
      ? { ...DEFAULT_RATE_LIMITS.pairingStatus, max: config.rateLimitPairingMax }
      : undefined,
    wsAgent: config.rateLimitWsAgentMax
      ? { ...DEFAULT_RATE_LIMITS.wsAgent, max: config.rateLimitWsAgentMax }
      : undefined,
  };
}

// Real server entry point. Everything here is also exercised piecemeal by
// integration tests via buildApp() directly -- this file only wires those
// pieces together and calls Bun.serve, so it's intentionally thin.
if (import.meta.main) {
  const config = loadConfig(process.env);
  const sql = getDb(config.databaseUrl);

  await runMigrations(sql);
  await bootstrapAdmin(sql, config);

  const app = buildApp({ sql, config, rateLimits: rateLimitsFromConfig(config) });
  const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket });

  // No secrets here -- just where we're listening.
  console.log(`mando hub listening on http://localhost:${server.port}`);
}

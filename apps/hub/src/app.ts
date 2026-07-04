import { Hono } from "hono";
import type postgres from "postgres";
import type { Config } from "./config";
import type { AuthVariables } from "./auth/middleware";
import { userRoutes } from "./users/routes";
import { pairingRoutes } from "./pairing/routes";
import { machineRoutes } from "./machines/routes";
import { Registry } from "./tunnel/registry";
import { tunnelWsHandler, websocket } from "./tunnel/ws";

// Re-exported so the real server entry (src/index.ts, task 2.9) and test
// helpers can pass the same Bun WebSocket handler into Bun.serve({
// websocket }) -- Bun.serve needs it at the top level, it can't be
// discovered from the Hono app alone.
export { websocket };

type Sql = ReturnType<typeof postgres>;

export type AppDeps = {
  sql: Sql;
  config: Config;
  // The tunnel Registry (live agent connections) is created once per
  // process and threaded through here -- explicitly, rather than as a
  // module-level singleton -- so routes, the /ws/agent handler, and tests
  // all observe the exact same in-memory table. Optional so pre-tunnel
  // callers/tests (pairing, users, auth) don't need to change; buildApp
  // falls back to a private Registry when omitted, which is fine for
  // anything that doesn't need to inspect connection state from outside.
  registry?: Registry;
  // Injectable tunnel timing so tests don't have to wait out the real
  // 30s ping cadence / 5s hello grace period -- see tunnel/ws.ts.
  tunnelPingIntervalMs?: number;
  tunnelHelloTimeoutMs?: number;
};

// buildApp is the single place both the real server entry (src/index.ts,
// added in a later task) and every integration test construct the Hono
// app, so routes/middleware wiring only ever happens in one spot. Later
// tasks (proxy) extend this by mounting more routers here.
export function buildApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const registry = deps.registry ?? new Registry();

  app.route("/", userRoutes(deps.sql));
  app.route("/", pairingRoutes(deps.sql));
  app.route("/", machineRoutes(deps.sql, registry));

  app.get(
    "/ws/agent",
    tunnelWsHandler({
      sql: deps.sql,
      registry,
      pingIntervalMs: deps.tunnelPingIntervalMs,
      helloTimeoutMs: deps.tunnelHelloTimeoutMs,
    }),
  );

  return app;
}

import { Hono } from "hono";
import type postgres from "postgres";
import type { Config } from "./config";
import type { AuthVariables } from "./auth/middleware";
import { userRoutes } from "./users/routes";
import { pairingRoutes } from "./pairing/routes";

type Sql = ReturnType<typeof postgres>;

export type AppDeps = {
  sql: Sql;
  config: Config;
};

// buildApp is the single place both the real server entry (src/index.ts,
// added in a later task) and every integration test construct the Hono
// app, so routes/middleware wiring only ever happens in one spot. Later
// tasks (pairing, machines, tunnel, proxy) extend this by mounting more
// routers here.
export function buildApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.route("/", userRoutes(deps.sql));
  app.route("/", pairingRoutes(deps.sql));

  return app;
}

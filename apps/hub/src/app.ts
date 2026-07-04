import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { join } from "node:path";
import type postgres from "postgres";
import type { Config } from "./config";
import type { AuthVariables } from "./auth/middleware";
import { userRoutes } from "./users/routes";
import { pairingRoutes } from "./pairing/routes";
import { machineRoutes } from "./machines/routes";
import { proxyRoutes } from "./proxy/routes";
import { Registry } from "./tunnel/registry";
import { tunnelWsHandler, websocket } from "./tunnel/ws";

// Where the built web SPA (apps/web) lives. Its build is produced later
// (Phase 5, Task 5.0) -- until then this directory won't exist, and every
// route below that touches it must degrade to a graceful 404 rather than
// fail app startup. Override with MANDO_WEB_DIR once Phase 5/6 finalize
// the real build output location (e.g. if it differs from a local
// `vite build` default).
const WEB_DIR =
  process.env.MANDO_WEB_DIR ?? join(import.meta.dir, "..", "..", "web", "dist");

function isApiOrWsPath(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/ws/");
}

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
  app.route("/", proxyRoutes(deps.sql, registry));

  app.get(
    "/ws/agent",
    tunnelWsHandler({
      sql: deps.sql,
      registry,
      pingIntervalMs: deps.tunnelPingIntervalMs,
      helloTimeoutMs: deps.tunnelHelloTimeoutMs,
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Static assets for the built web SPA (JS/CSS/images/etc). serveStatic
  // calls next() whenever a file isn't found -- including when WEB_DIR
  // itself doesn't exist yet -- so this never blocks startup or 500s.
  app.use("/*", serveStatic({ root: WEB_DIR }));

  // SPA fallback: any GET that isn't an API or /ws/agent route, and
  // wasn't served as a static asset above, gets index.html so client-side
  // routes (e.g. the /pair deep link, ${publicUrl}/pair?code=...) render
  // in the browser. Unknown /api/* routes stay a plain 404 instead of
  // being masked by the SPA shell.
  app.get("*", async (c) => {
    if (isApiOrWsPath(c.req.path)) return c.notFound();

    const index = Bun.file(join(WEB_DIR, "index.html"));
    if (!(await index.exists())) return c.notFound();

    return new Response(index, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  return app;
}

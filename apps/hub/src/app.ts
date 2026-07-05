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
import { providerRoutes } from "./providers/routes";
import { imageRoutes } from "./images/routes";
import { IMAGE_MAX_BYTES, type ProviderClientDeps } from "./images/provider-client";
import type { ModelClientDeps } from "./providers/model-client";
import { chatRoutes, MAX_MESSAGE_BODY_BYTES } from "./chat/routes";
import type { ChatClientDeps } from "./chat/provider-client";
import { Registry } from "./tunnel/registry";
import { tunnelWsHandler, websocket } from "./tunnel/ws";
import { createRateLimiter, DEFAULT_RATE_LIMITS, type RateLimitConfig } from "./middleware/rate-limit";
import { bodyLimit } from "hono/body-limit";
import { auditRoutes } from "./audit";

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

// Global Bun.serve({ maxRequestBodySize }) cap, applied to every route on
// this server -- Bun has no per-route body-size option, only a
// per-instance one, so this can't be set to exactly IMAGE_MAX_BYTES (10MB)
// without also capping every other route at that size. It has to stay
// above the largest legitimate non-image request body this hub already
// accepts: the composer attachments proxy (attachments.ts's
// MAX_ATTACHMENT_TOTAL_BYTES = 8MB raw, sent browser->hub as base64 data
// URLs inside JSON, ~4/3 inflation -> up to ~10.7MB). 16MB clears that
// with headroom while still being a real reduction from Bun's 128MiB
// default -- the actual, tighter 10MB cap for images specifically is
// enforced per-route by the `bodyLimit` middleware on /api/v1/images/edits
// below (and by images/provider-client.ts's IMAGE_MAX_BYTES check on the
// provider's response), so this global value is a coarse DoS backstop,
// not the mechanism that bounds image size.
export const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

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
  // Per-route rate-limit overrides (see middleware/rate-limit.ts). Omitted
  // routes fall back to DEFAULT_RATE_LIMITS; tests use this to set a low
  // max/windowMs so the 429 path doesn't require actually waiting out a
  // real window.
  rateLimits?: {
    login?: RateLimitConfig;
    pairingRequest?: RateLimitConfig;
    pairingStatus?: RateLimitConfig;
    wsAgent?: RateLimitConfig;
    images?: RateLimitConfig;
    chat?: RateLimitConfig;
  };
  // Overrides images/provider-client.ts's SSRF guard for the images
  // routes only -- unset (the production default) uses the real guard.
  // Tests use this to point generate/edit at a real local fake provider
  // server, which the real guard correctly always rejects (loopback,
  // plain http).
  imagesProviderDeps?: ProviderClientDeps;
  // Same as imagesProviderDeps, but for providers/model-client.ts's SSRF
  // guard on GET /api/v1/provider/models only.
  providerModelsDeps?: ModelClientDeps;
  // Same as imagesProviderDeps, but for chat/provider-client.ts's SSRF
  // guard on the streaming POST /api/v1/chat/conversations/:id/messages
  // route only.
  chatProviderDeps?: ChatClientDeps;
};

// buildApp is the single place both the real server entry (src/index.ts,
// added in a later task) and every integration test construct the Hono
// app, so routes/middleware wiring only ever happens in one spot. Later
// tasks (proxy) extend this by mounting more routers here.
export function buildApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const registry = deps.registry ?? new Registry();
  const rateLimits = deps.rateLimits ?? {};

  // Rate limiters must be registered before the routes they guard --
  // Hono composes matched handlers for a request in registration order, so
  // a middleware added after its route's handler would never run first.
  // See middleware/rate-limit.ts for the M3 fix this implements (no limiter
  // previously existed on any of these, which made /auth/login's full
  // argon2id verify and /pairing/request's DB insert an unauthenticated
  // CPU/DB exhaustion target).
  app.use("/api/v1/auth/login", createRateLimiter(rateLimits.login ?? DEFAULT_RATE_LIMITS.login));
  app.use(
    "/api/v1/pairing/request",
    createRateLimiter(rateLimits.pairingRequest ?? DEFAULT_RATE_LIMITS.pairingRequest),
  );
  app.use(
    "/api/v1/pairing/status",
    createRateLimiter(rateLimits.pairingStatus ?? DEFAULT_RATE_LIMITS.pairingStatus),
  );
  app.use("/ws/agent", createRateLimiter(rateLimits.wsAgent ?? DEFAULT_RATE_LIMITS.wsAgent));
  // Per the plan's Global Constraints ("rate-limit the gen/edit
  // endpoints"): only the two routes that call out to the user's own
  // provider are limited -- GET (list/raw) and DELETE are plain,
  // owner-scoped DB reads/writes with no outbound request to bound.
  app.use("/api/v1/images/generations", createRateLimiter(rateLimits.images ?? DEFAULT_RATE_LIMITS.images));
  app.use("/api/v1/images/edits", createRateLimiter(rateLimits.images ?? DEFAULT_RATE_LIMITS.images));
  // Caps the multipart request body itself at the same size as
  // IMAGE_MAX_BYTES (the cap already enforced on the provider's response
  // in images/provider-client.ts) -- otherwise a caller could upload an
  // arbitrarily large "source" image to /images/edits before this route
  // ever gets far enough to reject it on other grounds.
  app.use("/api/v1/images/edits", bodyLimit({ maxSize: IMAGE_MAX_BYTES }));
  // Only the message-send route calls out to the user's own provider (for
  // a full streamed reply) -- GET/POST conversations and DELETE are plain,
  // owner-scoped DB reads/writes with no outbound request to bound, same
  // split as the images routes above.
  app.use(
    "/api/v1/chat/conversations/:id/messages",
    createRateLimiter(rateLimits.chat ?? DEFAULT_RATE_LIMITS.chat),
  );
  // Caps the JSON body (content + base64 attachment data URLs) before this
  // route's own MAX_ATTACHMENT_TOTAL_BYTES check (chat/routes.ts) ever
  // runs -- same "route-specific bodyLimit ahead of the app-level backstop"
  // shape as images/edits' IMAGE_MAX_BYTES limit above.
  app.use("/api/v1/chat/conversations/:id/messages", bodyLimit({ maxSize: MAX_MESSAGE_BODY_BYTES }));

  app.route("/", userRoutes(deps.sql, registry));
  app.route("/", pairingRoutes(deps.sql));
  app.route("/", machineRoutes(deps.sql, registry));
  app.route("/", proxyRoutes(deps.sql, registry));
  app.route("/", providerRoutes(deps.sql, deps.config, deps.providerModelsDeps));
  app.route("/", imageRoutes(deps.sql, deps.config, deps.imagesProviderDeps));
  app.route("/", chatRoutes(deps.sql, deps.config, deps.chatProviderDeps));
  app.route("/", auditRoutes(deps.sql));

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

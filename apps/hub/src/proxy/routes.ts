import { Hono, type Context } from "hono";
import type postgres from "postgres";
import { requireUser, requireMachineOwnership, type AuthVariables } from "../auth/middleware";
import type { Registry } from "../tunnel/registry";
import { proxyRequest } from "../tunnel/proxy";

type Sql = ReturnType<typeof postgres>;

// Two registrations instead of one `/opencode/*` wildcard: Hono's router
// has no working `c.req.param("*")` accessor for a route that mixes a
// named param (`:id`) with a trailing wildcard (verified against the
// installed hono@4.12.27 -- it returns `undefined`), and the previous
// approach of computing the tail by slicing `c.req.path` at
// `machine.id`'s length was the actual vulnerability: Postgres's uuid
// cast accepts a 32-char hyphenless literal that still resolves to a
// machine whose canonical `id` is the 36-char hyphenated form, so the
// slice length (derived from the DB row) didn't match how many characters
// of the URL the `:id` segment actually occupied, and ate into the tail.
// Using a `{.*}` regex param instead makes Hono's own router -- not
// string arithmetic -- responsible for finding the tail's boundary, so it
// can never drift from whatever the router actually matched for `:id`,
// regardless of the id's length or percent-encoding. The exact-root
// pattern (no trailing slash) is registered separately because `{.*}`
// requires a path segment to attach to and won't match zero segments.
const ROUTE_PATTERN_ROOT = "/api/v1/machines/:id/opencode";
const ROUTE_PATTERN_TAIL = "/api/v1/machines/:id/opencode/:rest{.*}";

// Headers that must never be forwarded verbatim from the browser to the
// agent's local opencode server: `cookie` carries the hub session (a
// different trust boundary than the paired machine -- the agent has no
// business seeing it), `host` names the hub not the agent, `connection`
// is hop-by-hop, and `content-length` no longer matches once the body is
// re-encoded as base64 inside the frame.
const EXCLUDED_HEADERS = new Set(["cookie", "host", "connection", "content-length"]);

function forwardedHeaders(raw: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  raw.forEach((value, key) => {
    if (!EXCLUDED_HEADERS.has(key.toLowerCase())) headers[key] = value;
  });
  return headers;
}

// proxyRoutes mounts the authenticated tunnel-proxy route (as two Hono
// registrations sharing one handler -- see the pattern constants above)
// covering any method under /api/v1/machines/:id/opencode(/*) , forwarded
// to that machine's live agent connection (if any) via proxyRequest.
// Registered in buildApp alongside userRoutes/pairingRoutes/machineRoutes.
export function proxyRoutes(sql: Sql, registry: Registry): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  const handler = async (c: Context<{ Variables: AuthVariables }>) => {
    const machine = c.get("machine");
    const conn = registry.get(machine.id);
    if (!conn) return c.json({ error: "machine_offline" }, 503);

    // `rest` is `undefined` on the exact-root registration (no `:rest`
    // param exists there) and "" for a request ending exactly at
    // "/opencode/" on the tail registration -- both correctly become "/".
    const rest = c.req.param("rest") ?? "";
    const subPath = `/${rest}`;
    const search = new URL(c.req.url).search;

    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? Buffer.from(await c.req.arrayBuffer()).toString("base64") : null;

    return proxyRequest(conn, {
      method,
      path: `${subPath}${search}`,
      headers: forwardedHeaders(c.req.raw.headers),
      body,
    });
  };

  app.all(ROUTE_PATTERN_ROOT, requireUser(sql), requireMachineOwnership(sql), handler);
  app.all(ROUTE_PATTERN_TAIL, requireUser(sql), requireMachineOwnership(sql), handler);

  return app;
}

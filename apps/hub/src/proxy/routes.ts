import { Hono } from "hono";
import type postgres from "postgres";
import { requireUser, requireMachineOwnership, type AuthVariables } from "../auth/middleware";
import type { Registry } from "../tunnel/registry";
import { proxyRequest } from "../tunnel/proxy";

type Sql = ReturnType<typeof postgres>;

const ROUTE_PATTERN = "/api/v1/machines/:id/opencode/*";

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

// proxyRoutes mounts the single authenticated tunnel-proxy route: any
// method under /api/v1/machines/:id/opencode/* is forwarded to that
// machine's live agent connection (if any) via proxyRequest. Registered
// in buildApp alongside userRoutes/pairingRoutes/machineRoutes.
export function proxyRoutes(sql: Sql, registry: Registry): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.all(ROUTE_PATTERN, requireUser(sql), requireMachineOwnership(sql), async (c) => {
    const machine = c.get("machine");
    const conn = registry.get(machine.id);
    if (!conn) return c.json({ error: "machine_offline" }, 503);

    const prefix = `/api/v1/machines/${machine.id}/opencode`;
    const subPath = c.req.path.slice(prefix.length) || "/";
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
  });

  return app;
}

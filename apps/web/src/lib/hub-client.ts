// Client for the HUB's cookie-authenticated REST/SSE API (apps/hub).
//
// All requests are sent with `credentials: "include"` so the `mando_sess`
// cookie set by POST /api/v1/auth/login travels with every call. The base
// URL defaults to "" (same origin) because in production the hub serves
// this SPA itself; tests inject a different base (e.g. a stub server's
// `http://localhost:<port>`) via `createHubClient({ baseUrl })`.

export type HubUser = {
  id: string;
  email: string;
};

// Matches machineRoutes' `serializeMachine()` in apps/hub/src/machines/routes.ts
// exactly: GET /api/v1/machines returns `{ machines: Machine[] }` and
// GET /api/v1/machines/:id returns `{ machine: Machine }` (not bare arrays/objects).
export type Machine = {
  id: string;
  name: string;
  platform: string | null;
  online: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export class HubClientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HubClientError";
    this.status = status;
  }
}

export type OpencodeProxyClient = {
  // Targets `${base}/api/v1/machines/${machineId}/opencode/${path}` with
  // credentials included. `path` may be given with or without a leading
  // slash. Resolves to the raw Response (including non-2xx, e.g. the 503
  // `{error:"machine_offline"}` the hub returns when the machine's tunnel
  // isn't connected) -- callers decide how to handle status codes, mirroring
  // ordinary `fetch` semantics for a proxy passthrough.
  fetch(path: string, init?: RequestInit): Promise<Response>;
  // Returns an EventSource for the same proxied base, for the SSE event
  // stream endpoint. `withCredentials: true` is set explicitly so cookies
  // are sent even if `baseUrl` ever points at a different origin than the
  // page (same-origin EventSource requests send cookies by default either
  // way, so this is a no-op in the default same-origin configuration).
  events(path: string): EventSource;
};

export type HubClientOptions = {
  // Base URL prefixed to every request path. Defaults to "" (same origin),
  // since the hub serves this SPA in production. Override for tests to
  // point at a stub/test server.
  baseUrl?: string;
};

export interface HubClient {
  login(email: string, password: string): Promise<{ user: HubUser }>;
  logout(): Promise<void>;
  me(): Promise<HubUser | null>;
  listMachines(): Promise<Machine[]>;
  getMachine(id: string): Promise<Machine>;
  revokeMachine(id: string): Promise<void>;
  approvePairing(code: string): Promise<{ machineId: string }>;
  opencode(machineId: string): OpencodeProxyClient;
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function createHubClient(options: HubClientOptions = {}): HubClient {
  const baseUrl = options.baseUrl ?? "";

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
  }

  async function parseOrThrow<T>(res: Response, action: string): Promise<T> {
    if (!res.ok) throw new HubClientError(`${action} failed`, res.status);
    return (await res.json()) as T;
  }

  return {
    async login(email, password) {
      const res = await request("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      return parseOrThrow(res, "login");
    },

    async logout() {
      const res = await request("/api/v1/auth/logout", { method: "POST" });
      if (!res.ok) throw new HubClientError("logout failed", res.status);
    },

    async me() {
      const res = await request("/api/v1/me");
      if (res.status === 401) return null;
      return parseOrThrow<HubUser>(res, "me");
    },

    async listMachines() {
      const res = await request("/api/v1/machines");
      const data = await parseOrThrow<{ machines: Machine[] }>(res, "listMachines");
      return data.machines;
    },

    async getMachine(id) {
      const res = await request(`/api/v1/machines/${id}`);
      const data = await parseOrThrow<{ machine: Machine }>(res, "getMachine");
      return data.machine;
    },

    async revokeMachine(id) {
      const res = await request(`/api/v1/machines/${id}/revoke`, { method: "POST" });
      if (!res.ok) throw new HubClientError("revokeMachine failed", res.status);
    },

    async approvePairing(code) {
      const res = await request("/api/v1/pairing/approve", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      return parseOrThrow(res, "approvePairing");
    },

    opencode(machineId) {
      const proxyPath = `/api/v1/machines/${machineId}/opencode`;
      return {
        fetch(path, init) {
          return request(`${proxyPath}${withLeadingSlash(path)}`, init);
        },
        events(path) {
          return new EventSource(`${baseUrl}${proxyPath}${withLeadingSlash(path)}`, {
            withCredentials: true,
          });
        },
      };
    },
  };
}

// Client for the HUB's cookie-authenticated REST/SSE API (apps/hub).
//
// All requests are sent with `credentials: "include"` so the `mando_sess`
// cookie set by POST /api/v1/auth/login travels with every call. The base
// URL defaults to "" (same origin) because in production the hub serves
// this SPA itself; tests inject a different base (e.g. a stub server's
// `http://localhost:<port>`) via `createHubClient({ baseUrl })`.

import { getResponseErrorMessage } from "@/lib/error-message";

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
  connectDirectory: string | null;
};

export class HubClientError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HubClientError";
    this.status = status;
  }
}

// Matches providerRoutes' GET/PUT/DELETE /api/v1/provider in
// apps/hub/src/providers/routes.ts: the encrypted API key itself is NEVER
// returned to a client, only whether one is currently set (`hasKey`).
// `baseUrl`/`imageModel` are `null` when the user has no provider row yet
// (the GET handler's "no settings" branch returns exactly this shape).
export type Provider = {
  baseUrl: string | null;
  imageModel: string | null;
  hasKey: boolean;
};

// The PUT body providerRoutes accepts: `apiKey` omitted (or `undefined`)
// means "keep the existing encrypted key" -- there is no way to resend the
// current key, since GET never exposes it.
export type SetProviderInput = {
  baseUrl: string;
  apiKey?: string;
  imageModel?: string | null;
};

// Matches imageRoutes' `toMetadata()` in apps/hub/src/images/routes.ts.
// Never includes the raw image bytes -- those are only ever fetched via
// `imageRawUrl(id)`, a same-origin <img src>, not through this client.
export type GeneratedImage = {
  id: string;
  prompt: string | null;
  mime: string;
  sourceKind: string | null;
  createdAt: string;
};

export type GenerateImageInput = {
  prompt: string;
  size?: string;
};

// Mirrors imageRoutes' POST /api/v1/images/edits: either a freshly attached
// source file (sent multipart) or a reference to an image already stored
// for this user (sent as JSON).
export type EditImageInput =
  | { prompt: string; size?: string; image: File }
  | { prompt: string; size?: string; sourceImageId: string };

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
  // User-scoped, independent of any machine (see docs/superpowers/plans/
  // 2026-07-05-image-generation.md). getProvider() throws HubClientError
  // with status 503 (message "images_disabled") when the hub has no
  // MANDO_ENCRYPTION_KEY configured.
  getProvider(): Promise<Provider>;
  setProvider(input: SetProviderInput): Promise<void>;
  deleteProvider(): Promise<void>;
  generateImage(input: GenerateImageInput): Promise<GeneratedImage>;
  editImage(input: EditImageInput): Promise<GeneratedImage>;
  listImages(): Promise<GeneratedImage[]>;
  // Same-origin GET URL for the raw image bytes, for direct use as an
  // <img src> -- never fetched through this client, so the browser sends
  // the `mando_sess` cookie itself (same-origin requests always carry
  // cookies, unlike `fetch`, which needs `credentials: "include"`).
  imageRawUrl(id: string): string;
  deleteImage(id: string): Promise<void>;
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function createHubClient(options: HubClientOptions = {}): HubClient {
  const baseUrl = options.baseUrl ?? "";

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    // A `FormData` body (used by editImage's multipart upload) must NOT get
    // an explicit content-type here -- `fetch` sets its own
    // `multipart/form-data; boundary=...` from the FormData instance only
    // when the caller leaves the header unset. Forcing `application/json`
    // on it, like every other JSON-bodied call in this client, would send a
    // multipart body under the wrong content-type and the hub would fail
    // to parse it.
    if (
      init.body !== undefined &&
      !(init.body instanceof FormData) &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", "application/json");
    }
    return fetch(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
  }

  async function parseOrThrow<T>(res: Response, action: string): Promise<T> {
    if (!res.ok) throw new HubClientError(`${action} failed`, res.status);
    return (await res.json()) as T;
  }

  // Same as parseOrThrow, but surfaces the hub's own `{error: "..."}` body
  // (e.g. providerRoutes' unsafe-URL message, imageRoutes'
  // "provider_not_configured"/"images_disabled") as the thrown error's
  // message instead of a generic "<action> failed" -- callers (the
  // provider settings and Images pages) render that message directly, so a
  // useful, specific string has to survive past this client.
  async function parseOrThrowWithMessage<T>(
    res: Response,
    fallback: string,
  ): Promise<T> {
    if (!res.ok) {
      const message = await getResponseErrorMessage(res, fallback);
      throw new HubClientError(message, res.status);
    }
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

    async getProvider() {
      const res = await request("/api/v1/provider");
      return parseOrThrowWithMessage<Provider>(res, "getProvider failed");
    },

    async setProvider(input) {
      // `apiKey`/`imageModel` are only included when the caller actually
      // provided them -- matches providerRoutes' PUT contract, where an
      // omitted `apiKey` means "keep the existing encrypted key" and an
      // omitted `imageModel` means "leave it unchanged" (`null` explicitly
      // clears it).
      const body: { baseUrl: string; apiKey?: string; imageModel?: string | null } = {
        baseUrl: input.baseUrl,
      };
      if (input.apiKey) body.apiKey = input.apiKey;
      if (input.imageModel !== undefined) body.imageModel = input.imageModel;

      const res = await request("/api/v1/provider", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await parseOrThrowWithMessage(res, "setProvider failed");
    },

    async deleteProvider() {
      const res = await request("/api/v1/provider", { method: "DELETE" });
      await parseOrThrowWithMessage(res, "deleteProvider failed");
    },

    async generateImage(input) {
      const res = await request("/api/v1/images/generations", {
        method: "POST",
        body: JSON.stringify({ prompt: input.prompt, size: input.size }),
      });
      return parseOrThrowWithMessage<GeneratedImage>(res, "generateImage failed");
    },

    async editImage(input) {
      let res: Response;
      if ("image" in input) {
        const form = new FormData();
        form.set("prompt", input.prompt);
        if (input.size) form.set("size", input.size);
        form.set("image", input.image);
        res = await request("/api/v1/images/edits", { method: "POST", body: form });
      } else {
        res = await request("/api/v1/images/edits", {
          method: "POST",
          body: JSON.stringify({
            sourceImageId: input.sourceImageId,
            prompt: input.prompt,
            size: input.size,
          }),
        });
      }
      return parseOrThrowWithMessage<GeneratedImage>(res, "editImage failed");
    },

    async listImages() {
      const res = await request("/api/v1/images");
      const data = await parseOrThrowWithMessage<{ images: GeneratedImage[] }>(
        res,
        "listImages failed",
      );
      return data.images;
    },

    imageRawUrl(id) {
      return `${baseUrl}/api/v1/images/${id}/raw`;
    },

    async deleteImage(id) {
      const res = await request(`/api/v1/images/${id}`, { method: "DELETE" });
      await parseOrThrowWithMessage(res, "deleteImage failed");
    },
  };
}

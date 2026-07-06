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
  isAdmin: boolean;
};

// Matches GET /api/v1/users' `users[]` shape in apps/hub/src/users/routes.ts.
// Never includes password material -- the hub's listUsers repo fn omits it.
export type AdminUser = {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
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
  chatModel: string | null;
  hasKey: boolean;
};

// The PUT body providerRoutes accepts: `apiKey` omitted (or `undefined`)
// means "keep the existing encrypted key" -- there is no way to resend the
// current key, since GET never exposes it.
export type SetProviderInput = {
  baseUrl: string;
  apiKey?: string;
  imageModel?: string | null;
  chatModel?: string | null;
};

// Matches providerRoutes' GET /api/v1/provider/models: the raw list from
// the provider's own /models endpoint (only `id` survives the hub's
// parsing) -- chat-capability filtering (dropping embedding/whisper/
// kokoro/rerank/flux-* ids) happens client-side, in provider-settings.tsx.
export type ProviderModel = {
  id: string;
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
  // "Count": the hub loops the provider call this many times (clamped
  // 1..4 server-side, see imageRoutes' clampImageCount) and stores each
  // result -- so a single generateImage() call can return more than one
  // image. Omitted (or 1) keeps today's single-image behavior.
  n?: number;
};

// Matches chatRoutes' `toConversationJson()` in apps/hub/src/chat/routes.ts.
export type Conversation = {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
};

// Matches the `attachmentSchema` chatRoutes accepts on POST .../messages --
// `dataUrl` is a full `data:<mime>;base64,<payload>` string, the same shape
// lib/attachments.ts's `Attachment.dataUrl` already produces.
export type ChatAttachment = {
  mime: string;
  dataUrl: string;
  name?: string;
};

// Matches chatRoutes' `toMessageJson()`.
export type ChatMessage = {
  id: string;
  role: string;
  content: string;
  attachments: ChatAttachment[] | null;
  createdAt: string;
};

// Matches GET /api/v1/chat/conversations/:id's response shape: the
// conversation's own fields spread flat, plus its messages -- not nested
// under a `conversation` key.
export type ConversationWithMessages = Conversation & { messages: ChatMessage[] };

export type CreateConversationInput = {
  model?: string | null;
  title?: string | null;
};

export type SendChatMessageInput = {
  content: string;
  attachments?: ChatAttachment[];
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
  // Admin-only (backend requireAdmin). createUser maps to POST
  // /api/v1/auth/invite: the hub generates a one-time temp password and
  // returns it exactly once -- it is never retrievable afterwards.
  createUser(email: string): Promise<{ user: { id: string; email: string }; tempPassword: string }>;
  listUsers(): Promise<AdminUser[]>;
  adminDeleteUser(id: string): Promise<void>;
  // Self-service: re-authenticates with the current password, then rotates
  // it and signs out the user's other sessions server-side (the acting
  // session stays valid).
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  // Admin-only (backend requireAdmin). Promotes/demotes another user;
  // rejected with a 400 message if it would remove the last admin.
  setUserAdmin(id: string, isAdmin: boolean): Promise<{ id: string; email: string; isAdmin: boolean }>;
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
  // Throws HubClientError with status 400 (message "provider_not_configured")
  // when the user has no provider row yet.
  listProviderModels(): Promise<ProviderModel[]>;
  // Returns every image the hub generated for this one call -- always an
  // array, even for the common `n` omitted/1 case, since imageRoutes' POST
  // /api/v1/images/generations always responds `{images: [...]}` (see
  // Task 2: Generation richness).
  generateImage(input: GenerateImageInput): Promise<GeneratedImage[]>;
  editImage(input: EditImageInput): Promise<GeneratedImage>;
  listImages(): Promise<GeneratedImage[]>;
  // Same-origin GET URL for the raw image bytes, for direct use as an
  // <img src> -- never fetched through this client, so the browser sends
  // the `mando_sess` cookie itself (same-origin requests always carry
  // cookies, unlike `fetch`, which needs `credentials: "include"`).
  imageRawUrl(id: string): string;
  deleteImage(id: string): Promise<void>;
  // Standalone Chat (see docs/superpowers/plans/2026-07-05-chat-and-images-v2.md,
  // Task 5): user-scoped, independent of any machine, same 503
  // "images_disabled" gate as the provider/images surface above.
  listConversations(): Promise<Conversation[]>;
  createConversation(input?: CreateConversationInput): Promise<Conversation>;
  getConversation(id: string): Promise<ConversationWithMessages>;
  deleteConversation(id: string): Promise<void>;
  // POSTs the message and consumes the SSE response as it arrives:
  // `onDelta` fires once per streamed content chunk (chatRoutes' "delta"
  // events), `onDone` fires once with the persisted assistant message
  // ("done"), and `onError` fires when the provider call itself fails mid-
  // stream (chatRoutes' "error" event, e.g. an SSRF-guard rejection) --
  // note this is distinct from the returned promise rejecting, which only
  // happens for a non-streaming failure (a non-2xx response arriving
  // before the SSE body starts, e.g. 400 provider_not_configured, 404, 429,
  // 503 images_disabled).
  streamMessage(
    conversationId: string,
    input: SendChatMessageInput,
    onDelta: (content: string) => void,
    onError: (reason: string) => void,
    onDone: (message: ChatMessage) => void,
  ): Promise<void>;
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

// Per the SSE spec (and hono's `streamSSE` writer, apps/hub's chat/routes.ts
// dependency), a field line is "<name>:<space><value>" -- only the single
// space immediately after the colon is a separator, never trimmed further.
// A content delta can legitimately start or end with a space (token
// boundaries in a streamed reply), so this must not be `.trim()`ed.
function stripSseFieldPrefix(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

type ChatStreamHandlers = {
  onDelta: (content: string) => void;
  onError: (reason: string) => void;
  onDone: (message: ChatMessage) => void;
};

// Parses one complete SSE event block (everything between two blank lines,
// no trailing "\n\n") into its event name and joined data. A block with
// multiple `data:` lines joins them with "\n", matching browser EventSource
// behavior for multi-line payloads.
function parseSseEventBlock(block: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line.startsWith("event:")) {
      event = stripSseFieldPrefix(line, "event:");
    } else if (line.startsWith("data:")) {
      dataLines.push(stripSseFieldPrefix(line, "data:"));
    }
  }
  return { event, data: dataLines.join("\n") };
}

// Reads chatRoutes' POST .../messages SSE response to completion, dispatching
// each event to the matching handler as it arrives. "user_message" (the
// echoed, persisted user message) is intentionally not surfaced here -- the
// caller already has that content locally, since it just sent it.
async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function dispatch(block: string): void {
    if (!block.trim()) return;
    const { event, data } = parseSseEventBlock(block);
    if (event === "delta") {
      handlers.onDelta(data);
    } else if (event === "error") {
      handlers.onError(data);
    } else if (event === "done") {
      try {
        handlers.onDone(JSON.parse(data) as ChatMessage);
      } catch {
        // A malformed "done" payload leaves nothing useful to hand the
        // caller -- dropped rather than throwing out of the read loop.
      }
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        dispatch(buffer.slice(0, separatorIndex));
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
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

    async createUser(email) {
      const res = await request("/api/v1/auth/invite", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      return parseOrThrowWithMessage<{ user: { id: string; email: string }; tempPassword: string }>(
        res,
        "createUser failed",
      );
    },

    async listUsers() {
      const res = await request("/api/v1/users");
      const data = await parseOrThrowWithMessage<{ users: AdminUser[] }>(res, "listUsers failed");
      return data.users;
    },

    async adminDeleteUser(id) {
      const res = await request(`/api/v1/users/${id}`, { method: "DELETE" });
      await parseOrThrowWithMessage(res, "adminDeleteUser failed");
    },

    async changePassword(currentPassword, newPassword) {
      const res = await request("/api/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await parseOrThrowWithMessage(res, "changePassword failed");
    },

    async setUserAdmin(id, isAdmin) {
      const res = await request(`/api/v1/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isAdmin }),
      });
      return parseOrThrowWithMessage<{ id: string; email: string; isAdmin: boolean }>(res, "setUserAdmin failed");
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
      // `apiKey`/`imageModel`/`chatModel` are only included when the caller
      // actually provided them -- matches providerRoutes' PUT contract,
      // where an omitted `apiKey` means "keep the existing encrypted key"
      // and an omitted `imageModel`/`chatModel` means "leave it unchanged"
      // (`null` explicitly clears it).
      const body: { baseUrl: string; apiKey?: string; imageModel?: string | null; chatModel?: string | null } = {
        baseUrl: input.baseUrl,
      };
      if (input.apiKey) body.apiKey = input.apiKey;
      if (input.imageModel !== undefined) body.imageModel = input.imageModel;
      if (input.chatModel !== undefined) body.chatModel = input.chatModel;

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

    async listProviderModels() {
      const res = await request("/api/v1/provider/models");
      return parseOrThrowWithMessage<ProviderModel[]>(res, "listProviderModels failed");
    },

    async generateImage(input) {
      const res = await request("/api/v1/images/generations", {
        method: "POST",
        body: JSON.stringify({ prompt: input.prompt, size: input.size, n: input.n }),
      });
      const data = await parseOrThrowWithMessage<{ images: GeneratedImage[] }>(
        res,
        "generateImage failed",
      );
      return data.images;
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

    async listConversations() {
      const res = await request("/api/v1/chat/conversations");
      const data = await parseOrThrowWithMessage<{ conversations: Conversation[] }>(
        res,
        "listConversations failed",
      );
      return data.conversations;
    },

    async createConversation(input = {}) {
      // Same "only send a field the caller actually supplied" shape as
      // setProvider above -- createConversationSchema treats an omitted
      // model/title the same as an explicit null either way, but this
      // keeps the request body minimal for the common "just start a new,
      // untitled conversation" call.
      const body: { model?: string | null; title?: string | null } = {};
      if (input.model !== undefined) body.model = input.model;
      if (input.title !== undefined) body.title = input.title;

      const res = await request("/api/v1/chat/conversations", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return parseOrThrowWithMessage<Conversation>(res, "createConversation failed");
    },

    async getConversation(id) {
      const res = await request(`/api/v1/chat/conversations/${id}`);
      return parseOrThrowWithMessage<ConversationWithMessages>(res, "getConversation failed");
    },

    async deleteConversation(id) {
      const res = await request(`/api/v1/chat/conversations/${id}`, { method: "DELETE" });
      await parseOrThrowWithMessage(res, "deleteConversation failed");
    },

    async streamMessage(conversationId, input, onDelta, onError, onDone) {
      const res = await request(`/api/v1/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: input.content, attachments: input.attachments }),
      });
      // A non-2xx here means the SSE body never started (chatRoutes returns
      // these synchronously, before calling streamSSE) -- provider/SSRF
      // failures during an already-started stream arrive as an "error"
      // event instead (handled by onError below), never as a rejected
      // promise.
      if (!res.ok) {
        const message = await getResponseErrorMessage(res, "streamMessage failed");
        throw new HubClientError(message, res.status);
      }
      if (!res.body) {
        throw new HubClientError("streamMessage failed: empty response body", res.status);
      }
      await consumeChatStream(res.body, { onDelta, onError, onDone });
    },
  };
}

import { test, expect, beforeAll } from "bun:test";
import { getDb } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";
import { loadConfig, type Config } from "../../src/config";
import { buildApp } from "../../src/app";
import { createUser } from "../../src/users/repo";
import { upsertProviderSettings } from "../../src/providers/repo";
import { encryptSecret } from "../../src/crypto/secretbox";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
} from "../../src/chat/repo";
import { streamChat, ChatProviderError } from "../../src/chat/provider-client";

const url = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const sql = getDb(url);

const ENCRYPTION_KEY_HEX = "de".repeat(32);

let config: Config;
let disabledConfig: Config;

beforeAll(async () => {
  await runMigrations(sql);
  config = loadConfig({
    DATABASE_URL: url,
    COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
    PUBLIC_URL: "http://localhost:8080",
    MANDO_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX,
  });
  disabledConfig = loadConfig({
    DATABASE_URL: url,
    COOKIE_SECRET: "test-secret-that-is-at-least-32-characters",
    PUBLIC_URL: "http://localhost:8080",
  });
});

function uniqueEmail(tag: string): string {
  return `u${Date.now()}_${Math.random().toString(36).slice(2)}_${tag}@t.dev`;
}

async function registerAndLogin(
  app: ReturnType<typeof buildApp>,
  tag: string,
): Promise<{ userId: string; cookie: string }> {
  const email = uniqueEmail(tag);
  const password = "correct-password";
  const user = await createUser(sql, email, password);

  const loginRes = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("login did not set a session cookie");
  return { userId: user.id, cookie: setCookie.split(";")[0]! };
}

async function configureProvider(userId: string, baseUrl: string): Promise<void> {
  await upsertProviderSettings(sql, userId, {
    baseUrl,
    apiKeyEncrypted: encryptSecret("sk-test-provider-key", config),
    imageModel: null,
    chatModel: "test-chat-model",
  });
}

// Permissive SSRF-guard stub for provider-client tests below -- the real
// guard (exercised on its own in url-guard.test.ts and providers.test.ts)
// always and correctly rejects loopback/plain-http, which is exactly where
// these fake servers run. Injecting this isolates "does provider-client
// send/parse the stream correctly" from "does the SSRF guard work", which
// is a separate, already-covered concern.
const noopGuard = async () => {};

type FakeServer = { baseUrl: string; stop(): void; requests: Request[] };

function startFakeProviderServer(handler: (req: Request) => Promise<Response> | Response): FakeServer {
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      requests.push(req.clone());
      return handler(req);
    },
  });
  return {
    baseUrl: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
    requests,
  };
}

// Builds a raw OpenAI-compatible SSE body from a list of already-encoded
// `data: ...` payloads (each becomes its own event, terminated by a blank
// line) -- mirrors the shape verified live for this provider.
function sseBody(dataLines: string[]): string {
  return dataLines.map((line) => `data: ${line}\n\n`).join("");
}

async function drain<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

type SseEvent = { event?: string; data: string };

// Parses a full SSE response body into discrete events -- test-only
// helper, not the production parser (chat/provider-client.ts's is exercised
// directly by the provider-client tests below).
async function collectSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
      return { event, data: dataLines.join("\n") };
    });
}

function tinyPngDataUrl(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
}

// --- chat/repo: CRUD + owner-scoping ---

test("createConversation + listConversations are user-scoped and ordered by most recently updated", async () => {
  const owner = await createUser(sql, uniqueEmail("repo-owner"), "correct-password");
  const other = await createUser(sql, uniqueEmail("repo-other"), "correct-password");

  const first = await createConversation(sql, owner.id, { model: "m1", title: "first" });
  const second = await createConversation(sql, owner.id, { model: null, title: null });
  await createConversation(sql, other.id, { model: null, title: "not mine" });

  await appendMessage(sql, first.id, { role: "user", content: "hi" }); // bumps first's updated_at to newest

  const ownerList = await listConversations(sql, owner.id);
  expect(ownerList.map((c) => c.id)).toEqual([first.id, second.id]);

  const otherList = await listConversations(sql, other.id);
  expect(otherList).toHaveLength(1);
});

test("getConversation returns messages in order and null for another user's conversation", async () => {
  const owner = await createUser(sql, uniqueEmail("repo-get-owner"), "correct-password");
  const other = await createUser(sql, uniqueEmail("repo-get-other"), "correct-password");

  const conversation = await createConversation(sql, owner.id, { model: null, title: null });
  const userMsg = await appendMessage(sql, conversation.id, { role: "user", content: "hello" });
  const assistantMsg = await appendMessage(sql, conversation.id, { role: "assistant", content: "hi there" });

  const result = await getConversation(sql, conversation.id, owner.id);
  expect(result?.messages.map((m) => m.id)).toEqual([userMsg.id, assistantMsg.id]);
  expect(result?.messages[1]?.content).toBe("hi there");

  expect(await getConversation(sql, conversation.id, other.id)).toBeNull();
});

test("appendMessage stores attachments as jsonb and round-trips them", async () => {
  const owner = await createUser(sql, uniqueEmail("repo-attach"), "correct-password");
  const conversation = await createConversation(sql, owner.id, { model: null, title: null });

  const attachments = [{ mime: "image/png", dataUrl: tinyPngDataUrl(), name: "a.png" }];
  await appendMessage(sql, conversation.id, { role: "user", content: "look at this", attachments });

  const result = await getConversation(sql, conversation.id, owner.id);
  expect(result?.messages[0]?.attachments).toEqual(attachments);
});

test("deleteConversation is owner-scoped and cascades to its messages", async () => {
  const owner = await createUser(sql, uniqueEmail("repo-delete-owner"), "correct-password");
  const other = await createUser(sql, uniqueEmail("repo-delete-other"), "correct-password");

  const conversation = await createConversation(sql, owner.id, { model: null, title: null });
  await appendMessage(sql, conversation.id, { role: "user", content: "hi" });

  expect(await deleteConversation(sql, conversation.id, other.id)).toBe(false);
  expect(await deleteConversation(sql, conversation.id, owner.id)).toBe(true);
  expect(await getConversation(sql, conversation.id, owner.id)).toBeNull();

  const messages = await sql`select 1 from chat_messages where conversation_id = ${conversation.id}`;
  expect(messages).toHaveLength(0);
});

// --- chat/provider-client: streamChat SSE parsing ---

test("streamChat yields content and reasoning deltas separately and stops at [DONE]", async () => {
  const fake = startFakeProviderServer(async (req) => {
    expect(new URL(req.url).pathname).toBe("/chat/completions");
    expect(req.headers.get("authorization")).toBe("Bearer sk-fake-key");
    const body = (await req.json()) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("test-model");
    return new Response(
      sseBody([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] }),
        JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
        JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
        "[DONE]",
        // A trailing chunk after [DONE] must never be observed -- streamChat
        // returns as soon as it sees the sentinel.
        JSON.stringify({ choices: [{ delta: { content: "should never arrive" } }] }),
      ]),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });

  try {
    const deltas = await drain(
      streamChat(
        { baseUrl: fake.baseUrl, apiKey: "sk-fake-key", model: "test-model", messages: [{ role: "user", content: "hi" }] },
        { assertSafeUrl: noopGuard },
      ),
    );
    expect(deltas).toEqual([{ reasoning: "thinking..." }, { content: "Hello" }, { content: " world" }]);
  } finally {
    fake.stop();
  }
});

test("streamChat throws a typed request_failed error when the provider returns a non-2xx status", async () => {
  const fake = startFakeProviderServer(() => new Response("boom", { status: 500 }));

  try {
    const promise = drain(
      streamChat(
        { baseUrl: fake.baseUrl, apiKey: "sk-fake-key", model: null, messages: [] },
        { assertSafeUrl: noopGuard },
      ),
    );
    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(ChatProviderError);
      expect((err as ChatProviderError).reason).toBe("request_failed");
    }
  } finally {
    fake.stop();
  }
});

test("streamChat rejects an unsafe base URL by default (no stub injected)", async () => {
  const promise = drain(
    streamChat({ baseUrl: "https://169.254.169.254/v1", apiKey: "sk-key", model: null, messages: [] }),
  );
  await expect(promise).rejects.toThrow();
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ChatProviderError);
    expect((err as ChatProviderError).reason).toBe("unsafe_url");
  }
});

test("streamChat rejects rather than follows a redirect from the provider", async () => {
  const target = startFakeProviderServer(() => new Response(sseBody(["[DONE]"])));
  const redirecting = startFakeProviderServer(
    () => new Response(null, { status: 302, headers: { Location: `${target.baseUrl}/chat/completions` } }),
  );

  try {
    const promise = drain(
      streamChat(
        { baseUrl: redirecting.baseUrl, apiKey: "sk-fake-key", model: null, messages: [] },
        { assertSafeUrl: noopGuard },
      ),
    );
    await expect(promise).rejects.toThrow();
    expect(target.requests.length).toBe(0);
  } finally {
    redirecting.stop();
    target.stop();
  }
});

// --- routes ---

test("GET /api/v1/chat/conversations returns 503 images_disabled when encryption is not configured", async () => {
  const app = buildApp({ sql, config: disabledConfig });
  const { cookie } = await registerAndLogin(app, "disabled-list");

  const res = await app.request("/api/v1/chat/conversations", { headers: { Cookie: cookie } });
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "images_disabled" });
});

test("POST .../messages returns 400 provider_not_configured when the user has no provider row", async () => {
  const app = buildApp({ sql, config });
  const { cookie } = await registerAndLogin(app, "no-provider");

  const createRes = await app.request("/api/v1/chat/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  const conversation = await createRes.json();

  const res = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ content: "hi" }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "provider_not_configured" });
});

test("GET/DELETE/POST-messages return 404 for another user's conversation", async () => {
  const app = buildApp({ sql, config });
  const { userId: ownerId, cookie: ownerCookie } = await registerAndLogin(app, "owner-404");
  const { cookie: otherCookie } = await registerAndLogin(app, "other-404");
  await configureProvider(ownerId, "https://example.com/v1");

  const conversation = await createConversation(sql, ownerId, { model: null, title: null });

  const getRes = await app.request(`/api/v1/chat/conversations/${conversation.id}`, {
    headers: { Cookie: otherCookie },
  });
  expect(getRes.status).toBe(404);

  const postRes = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: otherCookie },
    body: JSON.stringify({ content: "hi" }),
  });
  expect(postRes.status).toBe(404);

  const deleteRes = await app.request(`/api/v1/chat/conversations/${conversation.id}`, {
    method: "DELETE",
    headers: { Cookie: otherCookie },
  });
  expect((await deleteRes.json()).deleted).toBe(false);

  const ownGetRes = await app.request(`/api/v1/chat/conversations/${conversation.id}`, {
    headers: { Cookie: ownerCookie },
  });
  expect(ownGetRes.status).toBe(200);
});

test("full streaming flow via a fake provider persists the user and assistant messages and streams tokens", async () => {
  const fake = startFakeProviderServer(async (req) => {
    expect(req.headers.get("authorization")).toBe("Bearer sk-test-provider-key");
    const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", content: "say hi" });
    return new Response(
      sseBody([
        JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo!" } }] }),
        "[DONE]",
      ]),
    );
  });

  try {
    const app = buildApp({ sql, config, chatProviderDeps: { assertSafeUrl: noopGuard } });
    const { userId, cookie } = await registerAndLogin(app, "full-stream");
    await configureProvider(userId, fake.baseUrl);

    const createRes = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    const conversation = await createRes.json();

    const res = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ content: "say hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSse(res);
    expect(events.find((e) => e.event === "user_message")).toBeTruthy();
    const deltaEvents = events.filter((e) => e.event === "delta").map((e) => e.data);
    expect(deltaEvents).toEqual(["Hel", "lo!"]);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeTruthy();
    expect(JSON.parse(doneEvent!.data).content).toBe("Hello!");
    expect(JSON.stringify(events)).not.toContain("sk-test-provider-key");

    const stored = await getConversation(sql, conversation.id, userId);
    expect(stored?.messages).toHaveLength(2);
    expect(stored?.messages[0]).toMatchObject({ role: "user", content: "say hi" });
    expect(stored?.messages[1]).toMatchObject({ role: "assistant", content: "Hello!" });
  } finally {
    fake.stop();
  }
});

test("vision: an attachment is forwarded to the provider as an image_url content part and persisted", async () => {
  const dataUrl = tinyPngDataUrl();
  const fake = startFakeProviderServer(async (req) => {
    const body = (await req.json()) as { messages: Array<{ role: string; content: unknown }> };
    const last = body.messages[body.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
    };
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0]).toEqual({ type: "text", text: "what is this" });
    expect(last.content[1]).toEqual({ type: "image_url", image_url: { url: dataUrl } });
    return new Response(sseBody([JSON.stringify({ choices: [{ delta: { content: "a pixel" } }] }), "[DONE]"]));
  });

  try {
    const app = buildApp({ sql, config, chatProviderDeps: { assertSafeUrl: noopGuard } });
    const { userId, cookie } = await registerAndLogin(app, "vision");
    await configureProvider(userId, fake.baseUrl);

    const createRes = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    const conversation = await createRes.json();

    const res = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        content: "what is this",
        attachments: [{ mime: "image/png", dataUrl, name: "a.png" }],
      }),
    });
    expect(res.status).toBe(200);
    await collectSse(res);

    const stored = await getConversation(sql, conversation.id, userId);
    expect(stored?.messages[0]?.attachments).toEqual([{ mime: "image/png", dataUrl, name: "a.png" }]);
  } finally {
    fake.stop();
  }
});

test("POST .../messages rejects an oversized attachment payload with 400 before calling the provider", async () => {
  const app = buildApp({ sql, config, chatProviderDeps: { assertSafeUrl: noopGuard } });
  const { userId, cookie } = await registerAndLogin(app, "attach-too-big");
  await configureProvider(userId, "https://example.com/v1");

  const createRes = await app.request("/api/v1/chat/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  const conversation = await createRes.json();

  const oversizedB64 = Buffer.alloc(8 * 1024 * 1024 + 1, 1).toString("base64");
  const res = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      content: "too big",
      attachments: [{ mime: "image/png", dataUrl: `data:image/png;base64,${oversizedB64}` }],
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "attachments_too_large" });
});

test("an unsafe provider base URL surfaces as an SSE error event, not a 400, and persists no assistant message", async () => {
  const app = buildApp({ sql, config });
  const { userId, cookie } = await registerAndLogin(app, "route-unsafe-url");
  await configureProvider(userId, "https://169.254.169.254/v1");

  const createRes = await app.request("/api/v1/chat/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({}),
  });
  const conversation = await createRes.json();

  const res = await app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ content: "hi" }),
  });
  expect(res.status).toBe(200);
  const events = await collectSse(res);
  const errorEvent = events.find((e) => e.event === "error");
  expect(errorEvent?.data).toBe("unsafe_url");

  const stored = await getConversation(sql, conversation.id, userId);
  expect(stored?.messages).toHaveLength(1);
  expect(stored?.messages[0]?.role).toBe("user");
});

test("exceeding the chat rate limit returns 429", async () => {
  const fake = startFakeProviderServer(() => new Response(sseBody(["[DONE]"])));

  try {
    const app = buildApp({
      sql,
      config,
      chatProviderDeps: { assertSafeUrl: noopGuard },
      rateLimits: { chat: { windowMs: 60_000, max: 2 } },
    });
    const { userId, cookie } = await registerAndLogin(app, "chat-ratelimit");
    await configureProvider(userId, fake.baseUrl);

    const createRes = await app.request("/api/v1/chat/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({}),
    });
    const conversation = await createRes.json();

    function sendMessage() {
      return app.request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ content: "hi" }),
      });
    }

    expect((await sendMessage()).status).toBe(200);
    expect((await sendMessage()).status).toBe(200);
    const limited = await sendMessage();
    expect(limited.status).toBe(429);
  } finally {
    fake.stop();
  }
});

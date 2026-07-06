import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createHubClient, HubClientError, type Machine } from "../src/lib/hub-client";

// These tests mock the global `fetch` (per the task-5.1 brief: "with a
// mocked fetch") so we can assert on the exact request the client makes --
// method, path, body, and the `credentials: "include"` option -- without
// standing up a real server. `originalFetch` is restored after every test
// so other suites in the same process aren't affected.
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createHubClient", () => {
  describe("login", () => {
    it("POSTs credentials to /api/v1/auth/login with the JSON body and credentials included", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ user: { id: "u1", email: "a@b.com" } })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = createHubClient();
      const result = await client.login("a@b.com", "hunter2");

      expect(fetchMock.mock.calls.length).toBe(1);
      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/auth/login");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
      expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com", password: "hunter2" });
      expect(result).toEqual({ user: { id: "u1", email: "a@b.com" } });
    });

    it("throws HubClientError on 401 bad credentials", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "invalid credentials" }, 401)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      await expect(client.login("a@b.com", "wrong")).rejects.toBeInstanceOf(HubClientError);
    });
  });

  describe("logout", () => {
    it("POSTs to /api/v1/auth/logout with credentials included", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().logout();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/auth/logout");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
    });
  });

  describe("me", () => {
    it("returns the user on 200", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ id: "u1", email: "a@b.com" })),
      ) as unknown as typeof fetch;

      const result = await createHubClient().me();
      expect(result).toEqual({ id: "u1", email: "a@b.com" });
    });

    it("returns null on 401", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
      ) as unknown as typeof fetch;

      const result = await createHubClient().me();
      expect(result).toBeNull();
    });
  });

  describe("listMachines", () => {
    it("GETs /api/v1/machines and returns the parsed, unwrapped machine list", async () => {
      const machines: Machine[] = [
        {
          id: "m1",
          name: "laptop",
          platform: "darwin",
          online: true,
          lastSeenAt: "2026-07-01T00:00:00.000Z",
          revokedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          connectDirectory: "/Users/dev/my-project",
        },
      ];
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ machines })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().listMachines();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/machines");
      expect(init.method).toBeUndefined(); // default GET
      expect(init.credentials).toBe("include");
      expect(result).toEqual(machines);
    });
  });

  describe("getMachine", () => {
    it("GETs /api/v1/machines/:id and returns the unwrapped machine", async () => {
      const machine: Machine = {
        id: "m1",
        name: "laptop",
        platform: null,
        online: false,
        lastSeenAt: null,
        revokedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        connectDirectory: null,
      };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ machine })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().getMachine("m1");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/machines/m1");
      expect(result).toEqual(machine);
    });
  });

  describe("revokeMachine", () => {
    it("POSTs to /api/v1/machines/:id/revoke", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().revokeMachine("m1");

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/machines/m1/revoke");
      expect(init.method).toBe("POST");
    });
  });

  describe("approvePairing", () => {
    it("POSTs the code to /api/v1/pairing/approve", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ machineId: "m1" })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().approvePairing("ABCD-1234");

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/pairing/approve");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ code: "ABCD-1234" });
      expect(result).toEqual({ machineId: "m1" });
    });
  });

  describe("opencode", () => {
    it("fetch() targets /api/v1/machines/:id/opencode/:path with credentials included, both with and without a leading slash", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(new Response("{}", { status: 200 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const proxy = createHubClient().opencode("m1");
      await proxy.fetch("session");
      await proxy.fetch("/session");

      const [urlA, initA = {}] = fetchMock.mock.calls[0];
      const [urlB] = fetchMock.mock.calls[1];
      expect(urlA).toBe("/api/v1/machines/m1/opencode/session");
      expect(urlB).toBe("/api/v1/machines/m1/opencode/session");
      expect(initA.credentials).toBe("include");
    });

    it("fetch() resolves against an injected baseUrl", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(new Response("{}", { status: 200 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const proxy = createHubClient({ baseUrl: "http://localhost:4567" }).opencode("m1");
      await proxy.fetch("session");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4567/api/v1/machines/m1/opencode/session");
    });

    it("events() returns an EventSource pointed at the same proxied base, with credentials", () => {
      // Bun's runtime does not implement a global EventSource (browser-only
      // API), so we install a minimal fake for this one assertion. The real
      // implementation is exercised in a browser via the Vite/SPA build,
      // where `EventSource` is a native global -- this test only verifies
      // the client constructs it with the right URL and options.
      class FakeEventSource {
        constructor(
          public url: string,
          public opts?: EventSourceInit,
        ) {}
      }
      const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
      (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

      try {
        const proxy = createHubClient().opencode("m1");
        const source = proxy.events("/events") as unknown as FakeEventSource;

        expect(source).toBeInstanceOf(FakeEventSource);
        expect(source.url).toBe("/api/v1/machines/m1/opencode/events");
        expect(source.opts).toEqual({ withCredentials: true });
      } finally {
        (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
      }
    });
  });

  // Per-user provider settings + generated images (see docs/superpowers/
  // plans/2026-07-05-image-generation.md, Task 4). All user-scoped, no
  // machine id in any path.
  describe("getProvider", () => {
    it("GETs /api/v1/provider and returns the parsed provider -- the encrypted key is never part of the response, so there is nothing for this client to leak", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(
          jsonResponse({
            baseUrl: "https://api.example.com/v1",
            imageModel: "flux-2-klein",
            chatModel: "gpt-4o-mini",
            hasKey: true,
          }),
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().getProvider();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/provider");
      expect(init.method).toBeUndefined(); // default GET
      expect(init.credentials).toBe("include");
      expect(result).toEqual({
        baseUrl: "https://api.example.com/v1",
        imageModel: "flux-2-klein",
        chatModel: "gpt-4o-mini",
        hasKey: true,
      });
    });

    it("throws HubClientError carrying the hub's own error text on a non-2xx response", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "images_disabled" }, 503)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      await expect(client.getProvider()).rejects.toBeInstanceOf(HubClientError);
      try {
        await client.getProvider();
        throw new Error("expected getProvider to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(HubClientError);
        expect((err as HubClientError).status).toBe(503);
        expect((err as HubClientError).message).toBe("images_disabled");
      }
    });
  });

  describe("setProvider", () => {
    it("PUTs baseUrl and imageModel WITHOUT an apiKey field when none is provided -- the key stays untouched server-side", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().setProvider({ baseUrl: "https://api.example.com/v1", imageModel: "flux-2-klein" });

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/provider");
      expect(init.method).toBe("PUT");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ baseUrl: "https://api.example.com/v1", imageModel: "flux-2-klein" });
      expect("apiKey" in body).toBe(false);
    });

    it("includes apiKey in the PUT body only when the caller supplies one", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().setProvider({ baseUrl: "https://api.example.com/v1", apiKey: "sk-secret" });

      const [, init = {}] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-secret" });
    });

    it("includes chatModel in the PUT body only when the caller supplies one", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().setProvider({ baseUrl: "https://api.example.com/v1", chatModel: "gpt-4o-mini" });

      const [, init = {}] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ baseUrl: "https://api.example.com/v1", chatModel: "gpt-4o-mini" });
      expect("apiKey" in body).toBe(false);
    });

    it("surfaces the server's validation message (e.g. an unsafe URL) as the thrown error's text", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "unsafe provider URL: only https URLs are allowed" }, 400)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      try {
        await client.setProvider({ baseUrl: "http://insecure.example.com" });
        throw new Error("expected setProvider to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(HubClientError);
        expect((err as HubClientError).status).toBe(400);
        expect((err as HubClientError).message).toBe("unsafe provider URL: only https URLs are allowed");
      }
    });
  });

  describe("deleteProvider", () => {
    it("DELETEs /api/v1/provider", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().deleteProvider();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/provider");
      expect(init.method).toBe("DELETE");
      expect(init.credentials).toBe("include");
    });
  });

  describe("listProviderModels", () => {
    it("GETs /api/v1/provider/models and returns the raw list", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(jsonResponse([{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }])),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().listProviderModels();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/provider/models");
      expect(init.method).toBeUndefined(); // default GET
      expect(init.credentials).toBe("include");
      expect(result).toEqual([{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }]);
    });

    it("throws HubClientError carrying the hub's own error text (e.g. provider_not_configured) on a non-2xx response", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "provider_not_configured" }, 400)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      try {
        await client.listProviderModels();
        throw new Error("expected listProviderModels to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(HubClientError);
        expect((err as HubClientError).status).toBe(400);
        expect((err as HubClientError).message).toBe("provider_not_configured");
      }
    });
  });

  describe("generateImage", () => {
    it("POSTs prompt/size/n to /api/v1/images/generations and returns every created image's metadata", async () => {
      const image = { id: "img1", prompt: "a cat", mime: "image/png", sourceKind: "generation", createdAt: "2026-07-05T00:00:00.000Z" };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ images: [image] }, 201)));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().generateImage({ prompt: "a cat", size: "1024x1024", n: 2 });

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/images/generations");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ prompt: "a cat", size: "1024x1024", n: 2 });
      expect(result).toEqual([image]);
    });

    it("maps a 400 provider_not_configured response to a matching HubClientError", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "provider_not_configured" }, 400)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      try {
        await client.generateImage({ prompt: "a cat" });
        throw new Error("expected generateImage to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(HubClientError);
        expect((err as HubClientError).status).toBe(400);
        expect((err as HubClientError).message).toBe("provider_not_configured");
      }
    });
  });

  describe("editImage", () => {
    it("sends a source file as multipart form data, without forcing a JSON content-type", async () => {
      const image = { id: "img2", prompt: "make it blue", mime: "image/png", sourceKind: "edit", createdAt: "2026-07-05T00:00:00.000Z" };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(image, 201)));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const file = new File([new Uint8Array([1, 2, 3])], "source.png", { type: "image/png" });
      const result = await createHubClient().editImage({ prompt: "make it blue", image: file });

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/images/edits");
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      const headers = new Headers(init.headers);
      expect(headers.has("content-type")).toBe(false);
      const form = init.body as FormData;
      expect(form.get("prompt")).toBe("make it blue");
      expect(form.get("image")).toBe(file);
      expect(result).toEqual(image);
    });

    it("sends a stored sourceImageId as a JSON body when no file is attached", async () => {
      const image = { id: "img3", prompt: "make it blue", mime: "image/png", sourceKind: "edit", createdAt: "2026-07-05T00:00:00.000Z" };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(image, 201)));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().editImage({ prompt: "make it blue", sourceImageId: "img1" });

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/images/edits");
      expect(JSON.parse(init.body as string)).toEqual({ sourceImageId: "img1", prompt: "make it blue", size: undefined });
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe("application/json");
    });
  });

  describe("listImages", () => {
    it("GETs /api/v1/images and returns the parsed, unwrapped image list", async () => {
      const images = [
        { id: "img1", prompt: "a cat", mime: "image/png", sourceKind: "generation", createdAt: "2026-07-05T00:00:00.000Z" },
      ];
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ images })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().listImages();

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/images");
      expect(result).toEqual(images);
    });
  });

  describe("imageRawUrl", () => {
    it("returns a same-origin GET URL for the raw image bytes without making any request", () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(new Response("{}")));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const url = createHubClient().imageRawUrl("img1");

      expect(url).toBe("/api/v1/images/img1/raw");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves against an injected baseUrl", () => {
      const url = createHubClient({ baseUrl: "http://localhost:4567" }).imageRawUrl("img1");
      expect(url).toBe("http://localhost:4567/api/v1/images/img1/raw");
    });
  });

  describe("deleteImage", () => {
    it("DELETEs /api/v1/images/:id", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true, deleted: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().deleteImage("img1");

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/images/img1");
      expect(init.method).toBe("DELETE");
      expect(init.credentials).toBe("include");
    });
  });

  // Standalone Chat (see docs/superpowers/plans/2026-07-05-chat-and-images-v2.md,
  // Task 5b). Matches apps/hub/src/chat/routes.ts exactly.
  describe("listConversations", () => {
    it("GETs /api/v1/chat/conversations and returns the unwrapped list", async () => {
      const conversations = [
        { id: "c1", title: "first", model: "gpt-4o-mini", createdAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z" },
      ];
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ conversations })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().listConversations();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/chat/conversations");
      expect(init.method).toBeUndefined(); // default GET
      expect(init.credentials).toBe("include");
      expect(result).toEqual(conversations);
    });
  });

  describe("createConversation", () => {
    it("POSTs an empty body when no input is given", async () => {
      const conversation = { id: "c1", title: null, model: null, createdAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z" };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(conversation, 201)));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().createConversation();

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/chat/conversations");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({});
      expect(result).toEqual(conversation);
    });

    it("includes only the fields the caller supplies", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(jsonResponse({ id: "c1", title: null, model: "gpt-4o-mini", createdAt: "", updatedAt: "" }, 201)),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().createConversation({ model: "gpt-4o-mini" });

      const [, init = {}] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ model: "gpt-4o-mini" });
    });
  });

  describe("getConversation", () => {
    it("GETs /api/v1/chat/conversations/:id and returns the flat conversation + messages", async () => {
      const body = {
        id: "c1",
        title: null,
        model: null,
        createdAt: "2026-07-05T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
        messages: [{ id: "m1", role: "user", content: "hi", attachments: null, createdAt: "2026-07-05T00:00:00.000Z" }],
      };
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(body)));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await createHubClient().getConversation("c1");

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/chat/conversations/c1");
      expect(result).toEqual(body);
    });
  });

  describe("deleteConversation", () => {
    it("DELETEs /api/v1/chat/conversations/:id", async () => {
      const fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ ok: true, deleted: true })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await createHubClient().deleteConversation("c1");

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/chat/conversations/c1");
      expect(init.method).toBe("DELETE");
      expect(init.credentials).toBe("include");
    });
  });

  describe("streamMessage", () => {
    // Builds a fetch Response whose body is a ReadableStream emitting the
    // given raw SSE text in one or more chunks -- mirrors the exact bytes
    // hono's streamSSE (apps/hub/src/chat/routes.ts) writes to the wire, so
    // this exercises the client's own SSE parser rather than any test-only
    // shortcut.
    function sseResponse(chunks: string[], status = 200): Response {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
    }

    it("POSTs content + attachments and dispatches delta/done events from the SSE stream", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(
          sseResponse([
            'event: user_message\ndata: {"id":"u1","role":"user","content":"hi","attachments":null,"createdAt":""}\n\n',
            "event: delta\ndata: Hel\n\n",
            "event: delta\ndata: lo!\n\n",
            'event: done\ndata: {"id":"a1","role":"assistant","content":"Hello!","attachments":null,"createdAt":""}\n\n',
          ]),
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const deltas: string[] = [];
      const errors: string[] = [];
      let done: unknown = null;

      await createHubClient().streamMessage(
        "c1",
        { content: "hi", attachments: [{ mime: "image/png", dataUrl: "data:image/png;base64,AA==", name: "a.png" }] },
        (content) => deltas.push(content),
        (reason) => errors.push(reason),
        (message) => {
          done = message;
        },
      );

      const [url, init = {}] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/v1/chat/conversations/c1/messages");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        content: "hi",
        attachments: [{ mime: "image/png", dataUrl: "data:image/png;base64,AA==", name: "a.png" }],
      });
      expect(deltas).toEqual(["Hel", "lo!"]);
      expect(errors).toEqual([]);
      expect(done).toEqual({ id: "a1", role: "assistant", content: "Hello!", attachments: null, createdAt: "" });
    });

    it("preserves a leading space in a delta's content (token boundary), not trimming it away", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(sseResponse(["event: delta\ndata: Hello\n\n", "event: delta\ndata:  world\n\n"])),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const deltas: string[] = [];
      await createHubClient().streamMessage(
        "c1",
        { content: "hi" },
        (content) => deltas.push(content),
        () => {},
        () => {},
      );

      expect(deltas).toEqual(["Hello", " world"]);
    });

    it("dispatches a mid-stream error event to onError without rejecting the returned promise", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(sseResponse(["event: error\ndata: unsafe_url\n\n"])),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const errors: string[] = [];
      await createHubClient().streamMessage(
        "c1",
        { content: "hi" },
        () => {},
        (reason) => errors.push(reason),
        () => {},
      );

      expect(errors).toEqual(["unsafe_url"]);
    });

    it("handles an event split across multiple stream chunks", async () => {
      const fetchMock = mock<FetchFn>(() =>
        Promise.resolve(sseResponse(["event: delta\ndata: Hel", "lo!\n\n"])),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const deltas: string[] = [];
      await createHubClient().streamMessage(
        "c1",
        { content: "hi" },
        (content) => deltas.push(content),
        () => {},
        () => {},
      );

      expect(deltas).toEqual(["Hello!"]);
    });

    it("rejects with HubClientError, without calling any handler, on a non-2xx response (e.g. 400 provider_not_configured)", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve(jsonResponse({ error: "provider_not_configured" }, 400)),
      ) as unknown as typeof fetch;

      const client = createHubClient();
      let onDeltaCalled = false;
      try {
        await client.streamMessage(
          "c1",
          { content: "hi" },
          () => {
            onDeltaCalled = true;
          },
          () => {
            onDeltaCalled = true;
          },
          () => {
            onDeltaCalled = true;
          },
        );
        throw new Error("expected streamMessage to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(HubClientError);
        expect((err as HubClientError).status).toBe(400);
        expect((err as HubClientError).message).toBe("provider_not_configured");
      }
      expect(onDeltaCalled).toBe(false);
    });
  });
});

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
});

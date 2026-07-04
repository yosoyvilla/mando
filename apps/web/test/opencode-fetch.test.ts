import { describe, it, expect, mock } from "bun:test";
import {
  opencodeJson,
  opencodeRequest,
  opencodeEvents,
  MachineOfflineError,
} from "../src/lib/opencode-fetch";
import type { HubClient } from "../src/lib/hub-client";

// These tests lock the opencode transport helpers to their contract with the
// hub's per-machine proxy: `path` is a REAL opencode HTTP path that must be
// forwarded VERBATIM (no rewriting) to `HubClient.opencode(machineId)`. A
// regression that mangled the path, or dropped the 503 -> MachineOfflineError
// translation, would break every hook that talks to a real `opencode serve`.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Minimal fake HubClient that records exactly which opencode path each helper
// forwards, and lets each test dictate the proxied Response. Only the
// `opencode(machineId)` surface the helpers touch is implemented.
function makeFakeClient(response: Response) {
  const fetchCalls: Array<{ machineId: string; path: string; init?: RequestInit }> =
    [];
  const eventCalls: Array<{ machineId: string; path: string }> = [];

  const client = {
    opencode(machineId: string) {
      return {
        fetch(path: string, init?: RequestInit) {
          fetchCalls.push({ machineId, path, init });
          return Promise.resolve(response);
        },
        events(path: string) {
          eventCalls.push({ machineId, path });
          return { url: path } as unknown as EventSource;
        },
      };
    },
  } as unknown as HubClient;

  return { client, fetchCalls, eventCalls };
}

describe("opencode-fetch helpers", () => {
  describe("opencodeJson", () => {
    it("forwards the real opencode path verbatim and returns parsed JSON", async () => {
      const { client, fetchCalls } = makeFakeClient(
        jsonResponse({ data: [{ id: "ses_1" }] }),
      );

      const result = await opencodeJson<{ data: unknown }>(
        "m1",
        "/api/session",
        undefined,
        client,
      );

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].machineId).toBe("m1");
      // The exact real opencode path -- NOT the old invented "/sessions".
      expect(fetchCalls[0].path).toBe("/api/session");
      expect(result).toEqual({ data: [{ id: "ses_1" }] });
    });

    it("passes method + body through unchanged (e.g. POST create)", async () => {
      const { client, fetchCalls } = makeFakeClient(jsonResponse({ data: {} }));

      await opencodeJson(
        "m1",
        "/api/session",
        { method: "POST", body: JSON.stringify({}) },
        client,
      );

      expect(fetchCalls[0].path).toBe("/api/session");
      expect(fetchCalls[0].init?.method).toBe("POST");
      expect(fetchCalls[0].init?.body).toBe("{}");
    });

    it("throws on a non-ok, non-503 response", async () => {
      const { client } = makeFakeClient(jsonResponse({ error: "boom" }, 500));

      await expect(
        opencodeJson("m1", "/api/session", undefined, client),
      ).rejects.toThrow("Request failed: 500");
    });
  });

  describe("opencodeRequest", () => {
    it("translates a 503 into MachineOfflineError", async () => {
      const { client } = makeFakeClient(
        jsonResponse({ error: "machine_offline" }, 503),
      );

      await expect(
        opencodeRequest("m1", "/api/session", undefined, client),
      ).rejects.toBeInstanceOf(MachineOfflineError);
    });

    it("returns the raw Response for a non-JSON body (e.g. /vcs/diff/raw)", async () => {
      const diff = new Response("diff --git a b\n", {
        status: 200,
        headers: { "content-type": "text/x-diff" },
      });
      const { client, fetchCalls } = makeFakeClient(diff);

      const res = await opencodeRequest("m1", "/vcs/diff/raw", undefined, client);

      expect(fetchCalls[0].path).toBe("/vcs/diff/raw");
      expect(await res.text()).toBe("diff --git a b\n");
    });
  });

  describe("opencodeEvents", () => {
    it("opens the SSE stream at the real /api/event path", () => {
      const { client, eventCalls } = makeFakeClient(jsonResponse({}));

      opencodeEvents("m1", "/api/event", client);

      expect(eventCalls).toEqual([{ machineId: "m1", path: "/api/event" }]);
    });
  });
});

describe("opencode-fetch through a real HubClient proxy", () => {
  // Uses the real createHubClient with a mocked global fetch so the assertion
  // covers the FULL proxied URL the hub receives:
  // `/api/v1/machines/:id/opencode/<realpath>`. This is the end-to-end guard
  // that the real opencode path survives all the way onto the wire.
  it("builds /api/v1/machines/:id/opencode/api/session for a session list", async () => {
    const { createHubClient } = await import("../src/lib/hub-client");
    const original = globalThis.fetch;
    const fetchMock = mock<(url: string, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(jsonResponse({ data: [] })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = createHubClient();
      await opencodeJson("m1", "/api/session", undefined, client);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "/api/v1/machines/m1/opencode/api/session",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

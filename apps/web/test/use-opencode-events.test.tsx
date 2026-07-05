import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig, mutate } from "swr";
import { useOpencodeEvents } from "../src/hooks/use-opencode-events";
import { useSessions } from "../src/hooks/use-opencode";
import { useSessionMessages } from "../src/hooks/use-session-messages";
import { useMachineStore } from "../src/stores/machine-store";

// Locks the SSE layer to the REAL opencode 1.17.13 wire contract:
//   - frames are `data: {"id","type","properties":{...}}` (payload field is
//     `properties`, matching the installed SDK's `Event` type -- the earlier
//     belief that the live server sent `.data` was wrong),
//   - the stream is opened at the real unprefixed `/event` path (`/api/event`
//     only serves the server-created-session store),
//   - `applyEvent` dispatches on the real event `type` names and reads fields
//     out of `.properties`.
// If anyone reverts the payload field to `.data` or renames an event case,
// feeding a real-shaped frame no longer updates the cache and these tests
// fail.

const PROXY = "/api/v1/machines/m1/opencode";
const SEED = {
  id: "ses_seed",
  title: "seed",
  time: { created: 1, updated: 1 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Fake EventSource so tests can push frames deterministically. Bun/happy-dom's
// EventSource would try to open a real network connection; this never does.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(
    public url: string,
    public opts?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  static eventStream(): FakeEventSource {
    const es = FakeEventSource.instances.find((i) => i.url.endsWith("/opencode/event"));
    if (!es) throw new Error("no /event EventSource opened");
    return es;
  }
}

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
let messageFetches = 0;

// NOTE: no custom `provider` here -- `applyEvent` in use-opencode-events.ts
// drives the GLOBAL SWR `mutate`, so the rendered hooks must share the global
// default cache for event-driven updates to reach them. The cache is cleared
// around every test (below) to keep them isolated.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    SWRConfig,
    { value: { dedupingInterval: 0 } },
    children,
  );
}

async function clearSwrCache() {
  await mutate(() => true, undefined, { revalidate: false });
}

// Renders the sessions list, one session's messages, and the SSE subscription
// together so cache mutations driven by events are observable via the hooks.
function useHarness() {
  const sessions = useSessions();
  const messages = useSessionMessages(SEED.id);
  useOpencodeEvents("m1");
  return { sessions, messages };
}

beforeEach(async () => {
  await clearSwrCache();
  FakeEventSource.instances = [];
  messageFetches = 0;
  useMachineStore.setState({ selectedMachineId: "m1" });
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

  globalThis.fetch = mock((url: string) => {
    if (url.includes("/message")) {
      messageFetches += 1;
      return Promise.resolve(jsonResponse([]));
    }
    if (url === `${PROXY}/session`) {
      return Promise.resolve(jsonResponse([SEED]));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  await clearSwrCache();
  globalThis.fetch = originalFetch;
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  useMachineStore.setState({ selectedMachineId: null });
});

describe("useOpencodeEvents", () => {
  it("opens the SSE stream at the real unprefixed /event path with credentials", async () => {
    renderHook(useHarness, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const es = FakeEventSource.eventStream();
    expect(es.url).toBe(`${PROXY}/event`);
    expect(es.opts).toEqual({ withCredentials: true });
  });

  it("applies a real `session.created` frame (payload under `.properties`)", async () => {
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() =>
      expect(result.current.sessions.data).toEqual([SEED]),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_1",
        type: "session.created",
        properties: {
          sessionID: "ses_new",
          info: { id: "ses_new", title: "new", time: { created: 2, updated: 2 } },
        },
      });
    });

    await waitFor(() => {
      const ids = (result.current.sessions.data ?? []).map(
        (s: { id: string }) => s.id,
      );
      expect(ids).toContain("ses_new");
    });
  });

  it("applies a real `session.deleted` frame using `.properties.sessionID`", async () => {
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() =>
      expect(result.current.sessions.data).toEqual([SEED]),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_2",
        type: "session.deleted",
        properties: {
          sessionID: "ses_seed",
          info: SEED,
        },
      });
    });

    await waitFor(() => {
      const ids = (result.current.sessions.data ?? []).map(
        (s: { id: string }) => s.id,
      );
      expect(ids).not.toContain("ses_seed");
    });
  });

  it("revalidates messages for the frame's `.properties.sessionID` on message.part.updated", async () => {
    renderHook(useHarness, { wrapper });
    // wait for the initial message load so the count reflects only the event.
    await waitFor(() => expect(messageFetches).toBeGreaterThan(0));
    const before = messageFetches;

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_3",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_seed",
          part: { id: "prt_1", type: "text" },
          time: { created: 3 },
        },
      });
    });

    await waitFor(() => expect(messageFetches).toBeGreaterThan(before));
  });

  it("ignores unparseable frames without throwing", async () => {
    renderHook(useHarness, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    expect(() => {
      act(() => {
        FakeEventSource.eventStream().onmessage?.({ data: "not json" });
      });
    }).not.toThrow();
  });
});

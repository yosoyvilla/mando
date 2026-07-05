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
import { useMachineStore } from "../src/stores/machine-store";
import {
  setNotifier,
  resetNotifier,
  setNotifyEnabled,
  type Notifier,
} from "../src/lib/notify";

// Verifies the Task 9 wiring: the SSE dispatch (use-opencode-events.ts)
// calls the lib/notify.ts seam on `session.idle` and `permission.asked`,
// and that seam's own enabled/hidden/permission gating (unit-tested
// directly in notify.test.ts) is what the dispatch relies on rather than
// re-implementing the checks at the call site.

const PROXY = "/api/v1/machines/m1/opencode";
const STORAGE_KEY = "mando-notify-enabled";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
    const es = FakeEventSource.instances.find((i) =>
      i.url.endsWith("/opencode/event"),
    );
    if (!es) throw new Error("no /event EventSource opened");
    return es;
  }
}

const originalFetch = globalThis.fetch;
const originalEventSource = (globalThis as { EventSource?: unknown })
  .EventSource;

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

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    value: hidden,
    configurable: true,
  });
}

function stubNotificationPermission(permission: NotificationPermission) {
  (globalThis as { Notification?: unknown }).Notification = {
    permission,
    requestPermission: mock(() => Promise.resolve(permission)),
  };
}

beforeEach(async () => {
  await clearSwrCache();
  FakeEventSource.instances = [];
  useMachineStore.setState({ selectedMachineId: "m1" });
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  globalThis.fetch = mock(() =>
    Promise.resolve(jsonResponse([])),
  ) as unknown as typeof fetch;
  localStorage.removeItem(STORAGE_KEY);
  setHidden(true);
  stubNotificationPermission("granted");
});

afterEach(async () => {
  await clearSwrCache();
  globalThis.fetch = originalFetch;
  (globalThis as { EventSource?: unknown }).EventSource = originalEventSource;
  useMachineStore.setState({ selectedMachineId: null });
  resetNotifier();
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe("useOpencodeEvents notifications", () => {
  it("notifies 'Run finished' on session.idle when enabled and hidden", async () => {
    const notifier = mock<Notifier>((_title, _options) => {});
    setNotifier(notifier);
    setNotifyEnabled(true);

    renderHook(() => useOpencodeEvents("m1"), { wrapper });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_idle",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      });
    });

    await waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));
    expect(notifier.mock.calls[0][0]).toBe("Run finished");
  });

  it("notifies 'Approval needed' on permission.asked when enabled and hidden", async () => {
    const notifier = mock<Notifier>((_title, _options) => {});
    setNotifier(notifier);
    setNotifyEnabled(true);

    renderHook(() => useOpencodeEvents("m1"), { wrapper });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_perm",
        type: "permission.asked",
        properties: {
          id: "perm_1",
          sessionID: "ses_1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      });
    });

    await waitFor(() => expect(notifier).toHaveBeenCalledTimes(1));
    expect(notifier.mock.calls[0][0]).toBe("Approval needed");
  });

  it("does not notify when the toggle is disabled", async () => {
    const notifier = mock<Notifier>((_title, _options) => {});
    setNotifier(notifier);
    setNotifyEnabled(false);

    renderHook(() => useOpencodeEvents("m1"), { wrapper });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_idle_2",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      });
    });

    // Give the debounced flush a tick to run, then assert no call landed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifier).not.toHaveBeenCalled();
  });

  it("does not notify when the tab is visible (not hidden)", async () => {
    const notifier = mock<Notifier>((_title, _options) => {});
    setNotifier(notifier);
    setNotifyEnabled(true);
    setHidden(false);

    renderHook(() => useOpencodeEvents("m1"), { wrapper });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.eventStream().emit({
        id: "evt_idle_3",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(notifier).not.toHaveBeenCalled();
  });
});

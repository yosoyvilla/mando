import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  jest,
  mock,
  spyOn,
} from "bun:test";
import { renderHook, act } from "@testing-library/react";
import {
  opencodeJson as realOpencodeJson,
  opencodeRequest as realOpencodeRequest,
  opencodeEvents as realOpencodeEvents,
  MachineOfflineError as RealMachineOfflineError,
} from "@/lib/opencode-fetch";

// Native `EventSource` auto-reconnects on transient errors on its own
// schedule, but behind Cloudflare it has been observed entering rapid error
// loops (ERR_HTTP2_PROTOCOL_ERROR) that hammer the hub. `useOpencodeEvents`
// wraps the source with a bounded exponential backoff (1s base, 2x growth,
// 30s cap, up to 500ms jitter) instead. `Math.random` is pinned to 0 below
// so the asserted delays are exact rather than "somewhere in a range".
//
// `opencodeEvents` (the only thing this hook actually calls out of
// lib/opencode-fetch) is mocked at the module level so the reconnect
// manager can be driven directly with a fake source, without going through
// the real HubClient -> `new EventSource(...)` chain.
//
// `mock.module()` patches live bindings for the WHOLE test process, not
// just this file (confirmed against Bun's docs: `mock.restore()` explicitly
// does not undo it) -- other suites (use-opencode-paths.test.tsx) import
// the same real functions from this module and would silently get the
// stubs below for the rest of the run otherwise. Snapshotting the real
// exports into plain local bindings *before* mocking, then restoring them
// via another `mock.module()` call in `afterAll`, undoes the patch for
// every file that runs after this one.
const realModule = {
  opencodeJson: realOpencodeJson,
  opencodeRequest: realOpencodeRequest,
  opencodeEvents: realOpencodeEvents,
  MachineOfflineError: RealMachineOfflineError,
};

class FakeSource {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mock(() => {});
}

let createdSources: FakeSource[] = [];

const opencodeEventsMock = mock(() => {
  const source = new FakeSource();
  createdSources.push(source);
  return source as unknown as EventSource;
});

mock.module("@/lib/opencode-fetch", () => ({
  ...realModule,
  opencodeEvents: opencodeEventsMock,
}));

const { useOpencodeEvents } = await import("../src/hooks/use-opencode-events");

afterAll(() => {
  mock.module("@/lib/opencode-fetch", () => realModule);
});

beforeEach(() => {
  createdSources = [];
  opencodeEventsMock.mockClear();
  jest.useFakeTimers();
  spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  jest.useRealTimers();
  (Math.random as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("useOpencodeEvents SSE reconnect backoff", () => {
  it("closes the failed source and re-creates at a growing delay, resetting after success", () => {
    renderHook(() => useOpencodeEvents("m1"));
    expect(createdSources).toHaveLength(1);
    const first = createdSources[0];

    // First error: close happens immediately, before the timer fires.
    act(() => {
      first.onerror?.();
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(createdSources).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(999);
    });
    expect(createdSources).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(createdSources).toHaveLength(2);
    const second = createdSources[1];

    // Second consecutive error: delay doubles to ~2000ms.
    act(() => {
      second.onerror?.();
    });
    expect(second.close).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(createdSources).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(createdSources).toHaveLength(3);
    const third = createdSources[2];

    // A successful open resets the attempt counter -- the next error should
    // schedule at the base delay again, not continue exponential growth.
    act(() => {
      third.onopen?.();
    });
    act(() => {
      third.onerror?.();
    });
    expect(third.close).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(999);
    });
    expect(createdSources).toHaveLength(3);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(createdSources).toHaveLength(4);
  });

  it("resets the attempt counter on a received message, not only on open", () => {
    renderHook(() => useOpencodeEvents("m1"));
    const first = createdSources[0];

    act(() => {
      first.onerror?.();
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    const second = createdSources[1];

    act(() => {
      second.onmessage?.({ data: JSON.stringify({ id: "e1", type: "unknown", properties: {} }) });
    });
    act(() => {
      second.onerror?.();
    });

    act(() => {
      jest.advanceTimersByTime(999);
    });
    expect(createdSources).toHaveLength(2);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(createdSources).toHaveLength(3);
  });

  it("cancels the pending reconnect timer and closes the current source on cleanup", () => {
    const { unmount } = renderHook(() => useOpencodeEvents("m1"));
    const first = createdSources[0];

    act(() => {
      first.onerror?.();
    });
    expect(first.close).toHaveBeenCalledTimes(1);

    unmount();

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    // No reconnect fires after unmount -- the pending timer was cancelled.
    expect(createdSources).toHaveLength(1);
  });
});

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
import { SWRConfig } from "swr";
import {
  useSessions,
  useSessionStatuses,
  useAgents,
  useProviders,
  usePermissions,
  useQuestions,
  useGitDiff,
  useCreateSession,
  useDeleteSession,
  useAbortSession,
  useReplyPermission,
  useReplyQuestion,
  useRejectQuestion,
  useSelectedMachine,
  permissionsPath,
  questionsPath,
} from "../src/hooks/use-opencode";
import { useMachineStore } from "../src/stores/machine-store";

// Regression guard tying every opencode DATA-LAYER OPERATION to the exact
// real opencode path it hits, observed at the wire via the hub proxy URL
// (`/api/v1/machines/<id>/opencode/<realpath>`). These use the real
// `createHubClient` singleton with a mocked global fetch. opencode 1.17.13
// has TWO endpoint families: `/api/*` only serves sessions created through
// the server, while the UNPREFIXED family (`/session`, `/session/status`,
// `/session/:id/abort`, ...) also serves sessions created by a plain
// `opencode` TUI -- the primary use case here. If anyone reverts a path back
// to the `/api/*` family, the asserted URL changes and the test fails.

const PROXY = "/api/v1/machines/m1/opencode";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock<FetchFn>>;

// Fresh SWR cache per render so cross-test cache reuse never suppresses a fetch.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children,
  );
}

beforeEach(() => {
  useMachineStore.setState({ selectedMachineId: "m1" });
  fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({ data: {} })));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useMachineStore.setState({ selectedMachineId: null });
});

function findCall(url: string) {
  return fetchMock.mock.calls.find(([callUrl]) => callUrl === url);
}

describe("useOpencode GET hooks -> real opencode paths", () => {
  const cases: Array<{ name: string; hook: () => unknown; path: string }> = [
    // No machine list is mocked in this suite, so `useSelectedMachine()`
    // resolves to `null` and the session list omits `?directory=` -- the
    // directory-scoped case is covered separately below.
    { name: "useSessions", hook: () => useSessions(), path: "/session" },
    {
      name: "useSessionStatuses",
      hook: () => useSessionStatuses(),
      path: "/session/status",
    },
    { name: "useAgents", hook: () => useAgents(), path: "/agent" },
    {
      name: "useProviders",
      hook: () => useProviders(),
      path: "/config/providers",
    },
    { name: "usePermissions", hook: () => usePermissions(), path: "/permission" },
    { name: "useQuestions", hook: () => useQuestions(), path: "/question" },
    { name: "useGitDiff", hook: () => useGitDiff(), path: "/vcs/diff/raw" },
  ];

  for (const { name, hook, path } of cases) {
    it(`${name} GETs ${PROXY}${path}`, async () => {
      const url = `${PROXY}${path}`;
      renderHook(hook, { wrapper });
      // `useSessions`/`useSessionStatuses` also compose `useSelectedMachine()`,
      // which fires its own `/api/v1/machines` fetch -- match on the exact
      // proxied URL rather than call order so that doesn't race this
      // assertion.
      await waitFor(() => expect(findCall(url)).toBeDefined());
      // GET: no explicit method override on the SWR fetcher path.
      const init = (findCall(url)?.[1] ?? {}) as RequestInit;
      expect(init.method).toBeUndefined();
    });
  }
});

describe("useOpencode mutation hooks -> real opencode paths", () => {
  it("useCreateSession POSTs an empty body to /session (no machine directory known)", async () => {
    fetchMock = mock<FetchFn>(() =>
      Promise.resolve(jsonResponse({ id: "ses_1" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useCreateSession(), { wrapper });
    await act(async () => {
      await result.current("ignored title");
    });

    // `useCreateSession` also composes `useSelectedMachine()`, which fires
    // its own `/api/v1/machines` fetch -- match on the POST rather than call
    // order so that doesn't race this assertion.
    const createCall = fetchMock.mock.calls.find(
      ([callUrl, callInit]) =>
        (callUrl as string) === `${PROXY}/session` && callInit?.method === "POST",
    );
    expect(createCall).toBeDefined();
    // No connectDirectory is known in this suite (no machine list mocked) --
    // body is `{}`. See the directory-scoped case below for the populated one.
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({});
  });

  it("useDeleteSession DELETEs the unprefixed /session/:id", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useDeleteSession(), { wrapper });
    await act(async () => {
      await result.current("ses_9");
    });

    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY}/session/ses_9`);
    expect(init.method).toBe("DELETE");
  });

  it("useAbortSession POSTs to /session/:id/abort (unprefixed family)", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAbortSession(), { wrapper });
    await act(async () => {
      await result.current("ses_9");
    });

    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY}/session/ses_9/abort`);
    expect(init.method).toBe("POST");
  });

  // `useReplyPermission`/`useReplyQuestion`/`useRejectQuestion` now also
  // compose `useSelectedMachine()` (to read `connectDirectory` for the
  // `?directory=` param -- see the directory-scoped describe block below),
  // which fires its own `/api/v1/machines` fetch alongside the reply POST.
  // Match on the reply call's own URL/method rather than call order so that
  // extra fetch doesn't race these assertions.
  it("useReplyPermission POSTs {reply,message} to /permission/:id/reply", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useReplyPermission(), { wrapper });
    await act(async () => {
      await result.current("perm_1", "once", "ok");
    });

    const [url, init = {}] = findCall(`${PROXY}/permission/perm_1/reply`) ?? [];
    expect(url).toBe(`${PROXY}/permission/perm_1/reply`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      reply: "once",
      message: "ok",
    });
  });

  it("useReplyQuestion POSTs {answers} to /question/:id/reply", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useReplyQuestion(), { wrapper });
    await act(async () => {
      await result.current("q_1", [["a"], ["b"]]);
    });

    const [url, init = {}] = findCall(`${PROXY}/question/q_1/reply`) ?? [];
    expect(url).toBe(`${PROXY}/question/q_1/reply`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ answers: [["a"], ["b"]] });
  });

  it("useRejectQuestion POSTs to /question/:id/reject", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useRejectQuestion(), { wrapper });
    await act(async () => {
      await result.current("q_1");
    });

    const [url, init = {}] = findCall(`${PROXY}/question/q_1/reject`) ?? [];
    expect(url).toBe(`${PROXY}/question/q_1/reject`);
    expect(init.method).toBe("POST");
  });
});

describe("useOpencode hooks -> scoped to the machine's connectDirectory", () => {
  const MACHINE = {
    id: "m1",
    name: "laptop",
    platform: "darwin",
    online: true,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    connectDirectory: "/Users/dev/project",
  };

  function mockMachineAndSessionFetch() {
    return mock<FetchFn>((url: string) => {
      if (url === "/api/v1/machines") {
        return Promise.resolve(jsonResponse({ machines: [MACHINE] }));
      }
      return Promise.resolve(jsonResponse([]));
    });
  }

  it("useSessions GETs /session?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(() => useSessions(), { wrapper });

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => (url as string).includes("/opencode/session?"))).toBe(true),
    );

    const sessionCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes("/opencode/session?"),
    );
    expect(sessionCall?.[0]).toBe(
      `${PROXY}/session?directory=${encodeURIComponent(MACHINE.connectDirectory)}`,
    );
  });

  it("useCreateSession POSTs with ?directory= once the machine's connectDirectory is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () => ({ create: useCreateSession(), machine: useSelectedMachine() }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.machine).not.toBeNull());

    await act(async () => {
      await result.current.create("ignored title");
    });

    // `directory` must travel as a QUERY param: real opencode 1.17.13
    // silently ignores a body `{directory}` and creates the session in the
    // serve process's own cwd project (verified live), so a body-based
    // create would land web sessions in the wrong project.
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        (url as string) ===
          `${PROXY}/session?directory=${encodeURIComponent(MACHINE.connectDirectory)}` &&
        init?.method === "POST",
    );
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({});
  });

  // Real opencode 1.17.13 scopes `/permission` and `/question` (and their
  // reply/reject endpoints) to the connect directory exactly like
  // `/session` -- verified live for `/permission`, see
  // docs/superpowers/plans's Global Constraints. Omitting `?directory=`
  // targets the server's own cwd project instead, and a reply without the
  // matching directory 404s even for a request that legitimately exists.

  it("usePermissions GETs /permission?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(() => usePermissions(), { wrapper });

    const expected = `${PROXY}${permissionsPath(MACHINE.connectDirectory)}`;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === expected)).toBe(
        true,
      ),
    );
  });

  it("useQuestions GETs /question?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderHook(() => useQuestions(), { wrapper });

    const expected = `${PROXY}${questionsPath(MACHINE.connectDirectory)}`;
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === expected)).toBe(
        true,
      ),
    );
  });

  it("useReplyPermission POSTs to /permission/:id/reply?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () => ({ reply: useReplyPermission(), machine: useSelectedMachine() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.machine).not.toBeNull());

    await act(async () => {
      await result.current.reply("perm_1", "once");
    });

    const expected = `${PROXY}/permission/perm_1/reply?directory=${encodeURIComponent(MACHINE.connectDirectory)}`;
    const call = fetchMock.mock.calls.find(([url]) => url === expected);
    expect(call).toBeDefined();
    expect(call?.[1]?.method).toBe("POST");
  });

  it("useReplyQuestion POSTs to /question/:id/reply?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () => ({ reply: useReplyQuestion(), machine: useSelectedMachine() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.machine).not.toBeNull());

    await act(async () => {
      await result.current.reply("q_1", [["a"]]);
    });

    const expected = `${PROXY}/question/q_1/reply?directory=${encodeURIComponent(MACHINE.connectDirectory)}`;
    const call = fetchMock.mock.calls.find(([url]) => url === expected);
    expect(call).toBeDefined();
    expect(call?.[1]?.method).toBe("POST");
  });

  it("useRejectQuestion POSTs to /question/:id/reject?directory=<connectDirectory> once the machine is known", async () => {
    fetchMock = mockMachineAndSessionFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(
      () => ({ reject: useRejectQuestion(), machine: useSelectedMachine() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.machine).not.toBeNull());

    await act(async () => {
      await result.current.reject("q_1");
    });

    const expected = `${PROXY}/question/q_1/reject?directory=${encodeURIComponent(MACHINE.connectDirectory)}`;
    const call = fetchMock.mock.calls.find(([url]) => url === expected);
    expect(call).toBeDefined();
    expect(call?.[1]?.method).toBe("POST");
  });
});

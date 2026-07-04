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
} from "../src/hooks/use-opencode";
import { useMachineStore } from "../src/stores/machine-store";

// Regression guard tying every opencode DATA-LAYER OPERATION to the exact
// real opencode path it hits, observed at the wire via the hub proxy URL
// (`/api/v1/machines/<id>/opencode/<realpath>`). These use the real
// `createHubClient` singleton with a mocked global fetch. If anyone reverts a
// path to the old invented vocabulary (`/sessions`, `/session/create`,
// `/session/status`, `/agents`, `/providers`, `/git/diff`, `/session/:id/abort`
// ...), the asserted URL changes and the test fails.

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

function firstUrl(): string {
  return fetchMock.mock.calls[0][0] as string;
}

describe("useOpencode GET hooks -> real opencode paths", () => {
  const cases: Array<{ name: string; hook: () => unknown; path: string }> = [
    { name: "useSessions", hook: () => useSessions(), path: "/api/session" },
    {
      name: "useSessionStatuses",
      hook: () => useSessionStatuses(),
      path: "/api/session/active",
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
      renderHook(hook, { wrapper });
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(firstUrl()).toBe(`${PROXY}${path}`);
      // GET: no explicit method override on the SWR fetcher path.
      const init = (fetchMock.mock.calls[0][1] ?? {}) as RequestInit;
      expect(init.method).toBeUndefined();
    });
  }
});

describe("useOpencode mutation hooks -> real opencode paths", () => {
  it("useCreateSession POSTs an empty body to /api/session", async () => {
    fetchMock = mock<FetchFn>(() =>
      Promise.resolve(jsonResponse({ data: { id: "ses_1" } })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useCreateSession(), { wrapper });
    await act(async () => {
      await result.current("ignored title");
    });

    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY}/api/session`);
    expect(init.method).toBe("POST");
    // Real POST /api/session has no `title` field -- body is always `{}`.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("useDeleteSession DELETEs the legacy /session/:id (not /api/session/:id)", async () => {
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

  it("useAbortSession POSTs to /api/session/:id/interrupt (opencode's name for abort)", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse({})));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAbortSession(), { wrapper });
    await act(async () => {
      await result.current("ses_9");
    });

    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY}/api/session/ses_9/interrupt`);
    expect(init.method).toBe("POST");
  });

  it("useReplyPermission POSTs {reply,message} to /permission/:id/reply", async () => {
    fetchMock = mock<FetchFn>(() => Promise.resolve(jsonResponse(true)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useReplyPermission(), { wrapper });
    await act(async () => {
      await result.current("perm_1", "once", "ok");
    });

    const [url, init = {}] = fetchMock.mock.calls[0];
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

    const [url, init = {}] = fetchMock.mock.calls[0];
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

    const [url, init = {}] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY}/question/q_1/reject`);
    expect(init.method).toBe("POST");
  });
});

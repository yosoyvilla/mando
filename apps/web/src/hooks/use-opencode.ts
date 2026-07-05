import useSWR from "swr";
import { useMachineStore } from "@/stores/machine-store";
import { opencodeJson, opencodeRequest } from "@/lib/opencode-fetch";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, Machine } from "@/lib/hub-client";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";

function useBackend() {
  const machineId = useMachineStore((s) => s.selectedMachineId);
  return machineId ? { machineId } : null;
}

// `path` is a REAL opencode HTTP path (e.g. "/session"), forwarded verbatim
// to the machine's local opencode server by the hub's per-machine proxy
// (apps/hub/src/proxy/routes.ts does no path rewriting). Every path this
// hook file uses is opencode's UNPREFIXED endpoint family -- the one that
// also serves sessions created by a plain `opencode` TUI, not just
// server-created ones (`/api/*`) -- and none of them wrap their payload in
// an envelope, so a single untyped fetcher (matching the old fetcher's
// implicit `res.json(): any`) covers every GET here; each `useSWR<T>` call
// site pins its own response shape.
function fetcher([machineId, path]: readonly [string, string]): Promise<any> {
  return opencodeJson(machineId, path);
}

// `/vcs/diff/raw` (unlike every other path this hook file touches) responds
// with a raw `text/x-diff` body, not JSON -- `opencodeJson`'s `res.json()`
// would throw `SyntaxError: Unexpected token 'd', "diff --gi"...` on it.
// Wraps the text in `{ diff }` so callers keep the same shape they had
// before this fix (`parsePatchFiles(data.diff)` in routes/_app/diff.tsx and
// app-sidebar.tsx).
async function rawDiffFetcher(
  [machineId, path]: readonly [string, string],
): Promise<{ diff: string }> {
  const res = await opencodeRequest(machineId, path);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return { diff: await res.text() };
}

// `GET /session` is scoped to a project directory via `?directory=<abs
// path>` -- omitting it serves the opencode server's own cwd project
// instead of the machine's connect directory. Shared with
// use-opencode-events.ts so its SSE-driven `mutate(sessionsKey(...))` calls
// target the exact same SWR key tuple `useSessions` subscribes with.
export function sessionsPath(connectDirectory?: string | null): string {
  return connectDirectory
    ? `/session?directory=${encodeURIComponent(connectDirectory)}`
    : "/session";
}

// Newest-first, matching Claude Code /rc's "what am I working on right now"
// framing -- the sidebar pins index 0 as the Live session. Shared with
// use-opencode-events.ts so an event-driven cache update (session.created/
// session.updated) re-sorts with the exact same comparator the initial
// fetch below uses, keeping the Live pin stable across both paths.
export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (a, b) =>
      (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
  );
}

// `GET /session`'s response is a bare array on real opencode (see
// `sessionsPath` above), but this hook file's generic `fetcher` types every
// GET as `any` -- so a dedicated fetcher is needed here to sort without
// affecting the other untyped consumers. Defensive `Array.isArray` guard:
// an unexpected non-array response (or a test double standing in for one)
// passes through unsorted rather than throwing inside the SWR fetch chain.
async function sessionsFetcher(
  [machineId, path]: readonly [string, string],
): Promise<Session[]> {
  const data = await opencodeJson<unknown>(machineId, path);
  return Array.isArray(data) ? sortSessions(data as Session[]) : (data as Session[]);
}

export function useMachines(client: HubClient = defaultHubClient) {
  return useSWR<Machine[]>("hub/machines", () => client.listMachines(), {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
  });
}

// Combines the selected-machine id (stored in `useMachineStore`) with the
// live machine list so callers get the current name/online status without
// re-deriving it themselves.
export function useSelectedMachine() {
  const machineId = useMachineStore((s) => s.selectedMachineId);
  const { data: machines } = useMachines();
  return machines?.find((machine) => machine.id === machineId) ?? null;
}

export function useSessions() {
  const backend = useBackend();
  const machine = useSelectedMachine();
  const path = sessionsPath(machine?.connectDirectory);

  return useSWR(
    backend ? ([backend.machineId, path] as const) : null,
    sessionsFetcher,
  );
}

// `GET /session/status` responds `{ [sessionID]: SessionStatus }` directly
// (no envelope) -- confirmed against a live opencode 1.17.13. Its idle
// response is `{}`; a quiet session is simply absent from the map rather
// than carrying an explicit `{ type: "idle" }` entry, so downstream reads
// (`$id.tsx`'s `sessionStatus?.type === "busy"` check, the `refreshInterval`
// below) must treat absence as "not busy" defensively.
export function useSessionStatuses() {
  const backend = useBackend();

  return useSWR<Record<string, SessionStatus>>(
    backend ? ([backend.machineId, "/session/status"] as const) : null,
    fetcher,
    {
      revalidateOnFocus: false,
      refreshInterval: (statuses) =>
        Object.values(statuses ?? {}).some((status) => status.type !== "idle")
          ? 1000
          : 0,
    },
  );
}

export function useProviders() {
  const backend = useBackend();

  // There is no `/api/config/providers` on real opencode (verified via
  // /doc against opencode 1.17.13). The provider+model catalog only lives
  // at the legacy (non-/api) `/config/providers` path, which already
  // returns the `{ providers: [...], default: {...} }` shape this hook's
  // callers expect -- so no response adaptation is needed, only the path.
  return useSWR(
    backend ? ([backend.machineId, "/config/providers"] as const) : null,
    fetcher,
  );
}

// Same version-drift situation as permissions/questions above: real
// opencode also has a "V2" agent catalog at `/api/agent`
// (`{ location, data: AgentV2Info[] }`, items shaped `{id, request,
// system?, description?, mode, hidden, permissions, ...}` -- no `name`
// field at all), separate from the legacy flat `/agent`
// (bare `Agent[]`, items shaped `{name, description?, mode, permission,
// options, model?:{modelID,providerID}, ...}` -- confirmed via /doc + live
// curl). The installed SDK's `Agent` type (imported by agent-select.tsx and
// $id.tsx, which render `agent.name`) matches only the legacy flat shape,
// so that's the one this hook targets.
export function useAgents() {
  const backend = useBackend();

  return useSWR(
    backend ? ([backend.machineId, "/agent"] as const) : null,
    fetcher,
  );
}

export function useCreateSession() {
  const backend = useBackend();
  const machine = useSelectedMachine();

  return async (_title?: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    // Real `POST /session` has no `title` field -- the server always
    // assigns "New session - <ISO timestamp>". `_title` is accepted for
    // source compatibility with existing callers but unused. `directory`
    // (confirmed against a live opencode 1.17.13) lands the new session in
    // the machine's connect directory rather than the opencode server's
    // own cwd; omitted when the machine has none.
    return opencodeJson(backend.machineId, "/session", {
      method: "POST",
      body: JSON.stringify(
        machine?.connectDirectory
          ? { directory: machine.connectDirectory }
          : {},
      ),
    });
  };
}

export function useDeleteSession() {
  const backend = useBackend();

  return async (sessionId: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    // `/api/session/{id}` only supports GET on real opencode (no DELETE --
    // verified via /doc). The legacy (non-/api) `DELETE /session/:id` is
    // the only real path that deletes a session; it returns a bare boolean.
    return opencodeJson(backend.machineId, `/session/${sessionId}`, {
      method: "DELETE",
    });
  };
}

export function useGitDiff() {
  const backend = useBackend();

  // Real opencode has no `/git/diff` endpoint. `GET /vcs/diff/raw` (confirmed
  // against a live opencode 1.17.13 server's `/doc` OpenAPI spec and live
  // curls) returns the working tree's unified diff as a raw `text/x-diff`
  // body -- the same output `git diff` itself would produce, and exactly
  // what `parsePatchFiles` here already parses via this hook's consumers
  // (routes/_app/diff.tsx, app-sidebar.tsx). The JSON `GET /vcs/diff`
  // (requires a `mode=git|branch` query param) returns an array of per-file
  // `{file, patch, additions, deletions, status}` diffs instead --
  // reassembling those `patch` strings into one blob would just reinvent
  // what `/vcs/diff/raw` already hands back directly, for no benefit.
  // Neither has an `/api/`-prefixed counterpart: like `/permission` and
  // `/config/providers`, `/vcs/*` is one of opencode's un-prefixed legacy
  // paths. `worktree` is dropped from the old shape -- no caller ever read
  // it, and the real server has nothing that maps to it.
  return useSWR<{ diff: string }>(
    backend ? ([backend.machineId, "/vcs/diff/raw"] as const) : null,
    rawDiffFetcher,
  );
}

// Permissions/questions have TWO parallel subsystems on real opencode
// 1.17.13: a legacy flat one (`/permission`, `/permission/:id/reply`,
// `permission.asked`/`permission.replied` events, data shape
// `{id,sessionID,permission,patterns,metadata,always,tool}`) and a newer
// per-session "V2" one (`/api/permission/request`,
// `/api/session/:id/permission/:id/reply`, `permission.v2.asked` events,
// data shape `{id,sessionID,action,resources,save,metadata,source}` --
// confirmed via /doc). The installed `@opencode-ai/sdk` (1.14.41, pinned in
// apps/web/package.json) only models the legacy flat shape -- its
// `PermissionRequest`/`QuestionRequest` types, which this app's rendering
// code (routes/_app/session/$id.tsx) already consumes, have no V2
// equivalent to import. Adopting the V2 paths would mean hand-typing an
// un-vetted schema and rewriting the permission/question card rendering,
// which is a data-model change, not the path/envelope fix this task scopes.
// So: stay on the legacy flat surface, which is verified to exist on the
// live server and is shape-compatible end to end. Residual risk: if
// opencode's current tool-permission flow only ever emits `permission.v2.*`
// internally, this UI may not surface live prompts even though the wiring
// is now correct against the endpoints it targets -- flagged in the report.
export function usePermissions() {
  const backend = useBackend();

  return useSWR(
    backend ? ([backend.machineId, "/permission"] as const) : null,
    fetcher,
  );
}

export function useReplyPermission() {
  const backend = useBackend();

  return async (
    requestId: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(backend.machineId, `/permission/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply, message }),
    });
  };
}

export function useQuestions() {
  const backend = useBackend();

  return useSWR(
    backend ? ([backend.machineId, "/question"] as const) : null,
    fetcher,
  );
}

export function useReplyQuestion() {
  const backend = useBackend();

  return async (requestId: string, answers: string[][]): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(backend.machineId, `/question/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    });
  };
}

export function useRejectQuestion() {
  const backend = useBackend();

  return async (requestId: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(backend.machineId, `/question/${requestId}/reject`, {
      method: "POST",
    });
  };
}

export function useAbortSession() {
  const backend = useBackend();

  return async (sessionId: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    // The unprefixed `/session/:id/abort` (confirmed against a live
    // opencode 1.17.13) replaces the `/api/*` family's
    // `/api/session/:id/interrupt`.
    return opencodeJson(backend.machineId, `/session/${sessionId}/abort`, {
      method: "POST",
    });
  };
}

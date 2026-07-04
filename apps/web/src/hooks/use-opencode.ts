import useSWR from "swr";
import { useMachineStore } from "@/stores/machine-store";
import { opencodeJson, opencodeRequest } from "@/lib/opencode-fetch";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, Machine } from "@/lib/hub-client";
import type { SessionStatus } from "@opencode-ai/sdk/v2";

function useBackend() {
  const machineId = useMachineStore((s) => s.selectedMachineId);
  return machineId ? { machineId } : null;
}

// `path` is a REAL opencode HTTP path (e.g. "/api/session"), forwarded
// verbatim to the machine's local opencode server by the hub's per-machine
// proxy (apps/hub/src/proxy/routes.ts does no path rewriting). Untyped
// (matches the old fetcher's implicit `res.json(): any`) so each
// `useSWR<T>` call site can pin its own response shape.
function fetcher([machineId, path]: readonly [string, string]): Promise<any> {
  return opencodeJson(machineId, path);
}

// Most opencode `/api/*` GET endpoints wrap their payload in `{ data: ... }`
// -- confirmed against a live `opencode serve` 1.17.13 via its /doc OpenAPI
// spec and live curls (see .superpowers/sdd/opencode-api-fix-report.md).
// `/config/providers` is the one path used here that has no /api prefix and
// no envelope, so unwrapping is opt-in per hook rather than built into the
// shared `fetcher`.
// Untyped (matches `fetcher`'s implicit `res.json(): any`) so each
// `useSWR<T>` call site can pin its own response shape, same convention as
// the shared `fetcher` above.
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

async function dataFetcher([machineId, path]: readonly [string, string]): Promise<any> {
  const body = await opencodeJson<{ data: unknown }>(machineId, path);
  return body.data;
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

  return useSWR(
    backend ? ([backend.machineId, "/api/session"] as const) : null,
    dataFetcher,
  );
}

// `/api/session/active` only reports sessions that are *currently running*:
// `{ data: { [sessionID]: { type: "running" } } }`. There is no "idle"
// entry for a quiet session -- it's simply absent from the map. Map
// presence -> "busy" so downstream code (`$id.tsx`'s
// `sessionStatus?.type === "busy"` check) keeps working; SSE's
// `session.next.retried` / `session.idle` handlers in use-opencode-events.ts
// refine an open session's status further once messages start streaming.
async function fetchSessionStatuses(
  machineId: string,
  path: string,
): Promise<Record<string, SessionStatus>> {
  const body = await opencodeJson<{ data: Record<string, { type: "running" }> }>(
    machineId,
    path,
  );
  return Object.fromEntries(
    Object.keys(body.data).map((sessionID) => [
      sessionID,
      { type: "busy" as const },
    ]),
  );
}

export function useSessionStatuses() {
  const backend = useBackend();

  return useSWR<Record<string, SessionStatus>>(
    backend ? ([backend.machineId, "/api/session/active"] as const) : null,
    ([machineId, path]: readonly [string, string]) =>
      fetchSessionStatuses(machineId, path),
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

  return async (_title?: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    // Real `POST /api/session` has no `title` field (its request schema is
    // `additionalProperties:false` over `{id?, agent?, model?, location?}`,
    // and empirically an extra `title` key is silently dropped) -- the
    // server always assigns "New session - <ISO timestamp>". `_title` is
    // accepted for source compatibility with existing callers but unused.
    const body = await opencodeJson<{ data: unknown }>(
      backend.machineId,
      "/api/session",
      { method: "POST", body: JSON.stringify({}) },
    );
    return body.data;
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

    // Real opencode calls this "interrupt", not "abort" (verified via
    // /doc); `/session/:id/abort` doesn't exist on either API surface.
    return opencodeJson(
      backend.machineId,
      `/api/session/${sessionId}/interrupt`,
      { method: "POST" },
    );
  };
}

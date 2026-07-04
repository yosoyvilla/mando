import useSWR from "swr";
import { useMachineStore } from "@/stores/machine-store";
import { opencodeJson } from "@/lib/opencode-fetch";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, Machine } from "@/lib/hub-client";
import type { SessionStatus } from "@opencode-ai/sdk/v2";

function useBackend() {
  const machineId = useMachineStore((s) => s.selectedMachineId);
  return machineId ? { machineId } : null;
}

// `path` is the same relative opencode-wrapper path the old local-mode
// server used under `/api/{provider}/{port}` -- only the transport (hub
// proxy for the selected machine, instead of a direct same-origin fetch)
// changed. Untyped (matches the old fetcher's implicit `res.json(): any`)
// so each `useSWR<T>` call site can pin its own response shape.
function fetcher([machineId, path]: readonly [string, string]): Promise<any> {
  return opencodeJson(machineId, path);
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

  return useSWR(backend ? [backend.machineId, "/sessions"] as const : null, fetcher);
}

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

  return useSWR(backend ? ([backend.machineId, "/providers"] as const) : null, fetcher);
}

export function useAgents() {
  const backend = useBackend();

  return useSWR(backend ? ([backend.machineId, "/agents"] as const) : null, fetcher);
}

export function useCreateSession() {
  const backend = useBackend();

  return async (title?: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(backend.machineId, "/session/create", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
  };
}

export function useDeleteSession() {
  const backend = useBackend();

  return async (sessionId: string): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(backend.machineId, `/session/${sessionId}`, {
      method: "DELETE",
    });
  };
}

export function useGitDiff() {
  const backend = useBackend();

  return useSWR<{ diff: string; worktree: string }>(
    backend ? ([backend.machineId, "/git/diff"] as const) : null,
    fetcher,
  );
}

export function usePermissions() {
  const backend = useBackend();

  return useSWR(backend ? ([backend.machineId, "/permissions"] as const) : null, fetcher);
}

export function useReplyPermission() {
  const backend = useBackend();

  return async (
    requestId: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ): Promise<any> => {
    if (!backend) throw new Error("No machine selected");

    return opencodeJson(
      backend.machineId,
      `/permission/${requestId}/reply`,
      { method: "POST", body: JSON.stringify({ reply, message }) },
    );
  };
}

export function useQuestions() {
  const backend = useBackend();

  return useSWR(backend ? ([backend.machineId, "/questions"] as const) : null, fetcher);
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

    return opencodeJson(backend.machineId, `/session/${sessionId}/abort`, {
      method: "POST",
    });
  };
}

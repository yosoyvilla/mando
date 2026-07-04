// Shared request helpers that route opencode API calls through the hub's
// per-machine proxy (`HubClient.opencode(machineId)`). `path` here is a
// REAL opencode HTTP path (e.g. "/api/session", "/api/session/:id/message")
// -- the hub forwards it verbatim to the machine's local `opencode serve`
// process (apps/hub/src/proxy/routes.ts does no rewriting), so callers must
// use opencode's actual API surface, not an invented wrapper shape.
import { hubClient } from "@/lib/hub-client-instance";
import type { HubClient } from "@/lib/hub-client";

// Thrown when the hub reports the target machine's tunnel isn't connected
// (503 `{error:"machine_offline"}`). Callers/UI can catch this specifically
// to show an "offline, run mando" prompt instead of a generic error.
export class MachineOfflineError extends Error {
  constructor() {
    super("Machine is offline. Run `mando` on it to reconnect.");
    this.name = "MachineOfflineError";
  }
}

export async function opencodeRequest(
  machineId: string,
  path: string,
  init?: RequestInit,
  client: HubClient = hubClient,
): Promise<Response> {
  const res = await client.opencode(machineId).fetch(path, init);
  if (res.status === 503) {
    throw new MachineOfflineError();
  }
  return res;
}

export async function opencodeJson<T>(
  machineId: string,
  path: string,
  init?: RequestInit,
  client?: HubClient,
): Promise<T> {
  const res = await opencodeRequest(machineId, path, init, client);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export function opencodeEvents(
  machineId: string,
  path: string,
  client: HubClient = hubClient,
): EventSource {
  return client.opencode(machineId).events(path);
}

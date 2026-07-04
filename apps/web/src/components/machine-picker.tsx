import { useCallback, useEffect, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, Machine } from "@/lib/hub-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/status-dot";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format-time";
import { ServerIcon, TrashIcon } from "@/components/icons/lucide";

interface MachinePickerProps {
  client?: HubClient;
  selectedMachineId?: string | null;
  onSelect: (machine: Machine) => void;
}

type PickerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; machines: Machine[] };

// The machine's `online` boolean is all `HubClient.listMachines()` gives us
// today (no separate health signal), so "degraded" collapses to the same
// offline treatment per the task brief ("degraded if you have health info,
// else just online/offline").
function statusLabel(machine: Machine): "Online" | "Offline" {
  return machine.online ? "Online" : "Offline";
}

export function MachinePicker({
  client = defaultHubClient,
  selectedMachineId,
  onSelect,
}: MachinePickerProps) {
  const [state, setState] = useState<PickerState>({ status: "loading" });
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // A revoked machine's tunnel is already closed hub-side (see
  // machines/routes.ts's POST /revoke) and it can never reconnect (its
  // tokens are revoked too), so there's nothing left for a user to do with
  // it here -- hide it rather than showing a permanently-offline card.
  const load = useCallback(() => {
    setState({ status: "loading" });
    client
      .listMachines()
      .then((machines) =>
        setState({
          status: "ready",
          machines: machines.filter((machine) => !machine.revokedAt),
        }),
      )
      .catch((err) => {
        console.error("Failed to load machines:", err);
        setState({
          status: "error",
          message:
            "Couldn't load your machines. Check your connection and try again.",
        });
      });
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRevoke(machine: Machine) {
    if (revokingId) return;
    setRevokingId(machine.id);
    try {
      await client.revokeMachine(machine.id);
      load();
    } finally {
      setRevokingId(null);
    }
  }

  if (state.status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading machines"
        className="grid gap-3 md:grid-cols-2"
      >
        <span className="sr-only">Loading machines…</span>
        {[0, 1].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="overflow-hidden rounded-lg border border-border/40 bg-bg shadow-xs"
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5">
              <div className="h-4 w-28 rounded motion-safe:animate-pulse bg-muted" />
              <div className="h-5 w-16 rounded motion-safe:animate-pulse bg-muted" />
            </div>
            <div className="flex items-center gap-2 border-t border-border/30 bg-muted/10 px-3 py-1.5">
              <div className="h-3 w-12 rounded motion-safe:animate-pulse bg-muted" />
              <div className="ml-auto h-3 w-20 rounded motion-safe:animate-pulse bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3">
        <div
          role="alert"
          className="rounded-md bg-danger-subtle p-3 text-danger-subtle-fg"
        >
          {state.message}
        </div>
        <Button onPress={load}>Retry</Button>
      </div>
    );
  }

  if (state.machines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/50 bg-muted/5 py-8 text-center text-muted-fg">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted/50">
          <ServerIcon className="size-6 text-muted-fg/50" />
        </div>
        <p className="font-medium text-fg">No machines paired yet</p>
        <p className="text-sm">
          Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            mando connect
          </code>{" "}
          on a machine, then approve the pairing request to get started.
        </p>
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Machines"
      className="grid gap-3 md:grid-cols-2"
    >
      {state.machines.map((machine) => {
        const isSelected = machine.id === selectedMachineId;
        const label = statusLabel(machine);

        return (
          <div
            key={machine.id}
            role="listitem"
            className="min-w-0 overflow-hidden rounded-lg border border-border/40 bg-bg shadow-sm data-[selected=true]:border-primary"
            data-selected={isSelected}
          >
            <button
              type="button"
              aria-pressed={isSelected}
              disabled={!machine.online}
              onClick={() => onSelect(machine)}
              className="group flex w-full min-w-0 flex-col text-left outline-none transition-colors hover:bg-muted/5 focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2.5">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <StatusDot online={machine.online} />
                  <span className="min-w-0 truncate font-mono text-base font-medium tracking-tight text-fg">
                    {machine.name}
                  </span>
                </span>
                <Badge
                  intent={machine.online ? "success" : "secondary"}
                  isCircle={false}
                  className="font-mono uppercase"
                >
                  {label}
                </Badge>
              </div>
              <div className="flex items-center gap-2 border-t border-border/30 bg-muted/10 px-3 py-1.5 text-xs text-muted-fg">
                {machine.platform && (
                  <span className="font-mono">{machine.platform}</span>
                )}
                <span className="ml-auto font-mono tabular-nums">
                  {machine.online ? (
                    "Ready"
                  ) : machine.lastSeenAt ? (
                    <span
                      title={
                        formatAbsoluteTime(machine.lastSeenAt) ?? undefined
                      }
                    >
                      Last seen{" "}
                      {formatRelativeTime(machine.lastSeenAt) ?? "unknown"}
                    </span>
                  ) : (
                    "Last seen never"
                  )}
                </span>
              </div>
            </button>
            <div className="flex justify-end border-t border-border/30 px-3 py-1.5">
              <Button
                size="xs"
                intent="outline"
                aria-label={`Revoke ${machine.name}`}
                isDisabled={revokingId === machine.id}
                onPress={() => handleRevoke(machine)}
              >
                <TrashIcon size="12px" />
                {revokingId === machine.id ? "Revoking..." : "Revoke"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { hubClient as defaultHubClient } from "@/lib/hub-client-instance";
import type { HubClient, Machine } from "@/lib/hub-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ServerIcon } from "@/components/icons/lucide";

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

  const load = useCallback(() => {
    setState({ status: "loading" });
    client
      .listMachines()
      .then((machines) => setState({ status: "ready", machines }))
      .catch((err) =>
        setState({
          status: "error",
          message:
            err instanceof Error ? err.message : "Failed to load machines",
        }),
      );
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div className="py-12 text-center text-muted-fg">
        Loading machines...
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
            mando
          </code>{" "}
          on a machine and approve the pairing request to get started.
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
          <div key={machine.id} role="listitem" className="min-w-0">
            <button
              type="button"
              aria-pressed={isSelected}
              disabled={!machine.online}
              onClick={() => onSelect(machine)}
              className="group flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/40 bg-bg text-left shadow-sm outline-none transition-colors hover:border-border hover:bg-muted/5 focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 data-[selected=true]:border-primary"
              data-selected={isSelected}
            >
              <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-base font-medium tracking-tight text-fg">
                  {machine.name}
                </span>
                <Badge
                  intent={machine.online ? "success" : "secondary"}
                  isCircle={false}
                >
                  {label}
                </Badge>
              </div>
              <div className="flex items-center gap-2 border-t border-border/30 bg-muted/10 px-3 py-1.5 text-xs text-muted-fg">
                {machine.platform && <span>{machine.platform}</span>}
                <span className="ml-auto tabular-nums">
                  {machine.online
                    ? "Ready"
                    : `Last seen ${machine.lastSeenAt ?? "never"}`}
                </span>
              </div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

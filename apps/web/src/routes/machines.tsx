import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RequireAuth } from "@/components/require-auth";
import { MachinePicker } from "@/components/machine-picker";
import { useMachineStore } from "@/stores/machine-store";
import type { Machine } from "@/lib/hub-client";

export const Route = createFileRoute("/machines")({
  component: MachinesPage,
});

function MachinesPage() {
  const navigate = useNavigate();
  const selectedMachineId = useMachineStore((s) => s.selectedMachineId);
  const setSelectedMachineId = useMachineStore((s) => s.setSelectedMachineId);

  function handleSelect(machine: Machine) {
    if (!machine.online) return;
    setSelectedMachineId(machine.id);
    navigate({ to: "/" });
  }

  return (
    <RequireAuth>
      <div className="container mx-auto max-w-4xl space-y-8 px-4 py-10">
        <div className="space-y-2">
          <h1 className="bg-gradient-to-r from-fg to-muted-fg bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            Machines
          </h1>
          <p className="text-lg text-muted-fg">
            Select a paired machine to connect. Pair a new one from{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              mando
            </code>
            .
          </p>
        </div>

        <MachinePicker
          selectedMachineId={selectedMachineId}
          onSelect={handleSelect}
        />
      </div>
    </RequireAuth>
  );
}

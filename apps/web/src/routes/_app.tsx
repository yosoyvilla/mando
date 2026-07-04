import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import AppSidebar from "@/components/app-sidebar";
import { AppSidebarNav } from "@/components/app-sidebar-nav";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { BreadcrumbProvider } from "@/contexts/breadcrumb-context";
import { RequireAuth } from "@/components/require-auth";
import { useMachines } from "@/hooks/use-opencode";
import { useMachineStore } from "@/stores/machine-store";
import { useOpencodeEvents } from "@/hooks/use-opencode-events";

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});

function AppLayout() {
  return (
    <RequireAuth>
      <ConnectedAppLayout />
    </RequireAuth>
  );
}

function ConnectedAppLayout() {
  const selectedMachineId = useMachineStore((s) => s.selectedMachineId);
  const setSelectedMachineId = useMachineStore((s) => s.setSelectedMachineId);
  const clearSelectedMachineId = useMachineStore(
    (s) => s.clearSelectedMachineId,
  );
  const { data: machines } = useMachines();

  useEffect(() => {
    if (!machines) return;

    if (machines.length === 0) {
      if (selectedMachineId) clearSelectedMachineId();
      return;
    }

    const stillPresent =
      selectedMachineId &&
      machines.some((machine) => machine.id === selectedMachineId);

    if (stillPresent) return;

    // Prefer an online machine on first auto-select, but fall back to the
    // first paired machine if all are offline -- the session view/sidebar
    // handle the offline state, so there's still something useful to show
    // rather than bouncing the user in a redirect loop.
    const preferred = machines.find((machine) => machine.online) ?? machines[0];
    setSelectedMachineId(preferred.id);
  }, [
    clearSelectedMachineId,
    machines,
    selectedMachineId,
    setSelectedMachineId,
  ]);

  useOpencodeEvents(selectedMachineId);

  if (!selectedMachineId) {
    // `machines` is `undefined` while the initial `useMachines()` fetch is
    // still in flight -- on a fresh page load that's true for at least one
    // render, before the auto-select effect above has anything to work
    // with. Treat "still loading" the same as "has machines" (wait) rather
    // than falling through to the empty-state redirect: otherwise every
    // fresh load races this component's own auto-select effect and always
    // loses, bouncing a user who *has* an online machine to /machines
    // before that effect gets a chance to run.
    if (!machines || machines.length > 0) return null;
    return <Navigate to="/machines" />;
  }

  return (
    <BreadcrumbProvider>
      <SidebarProvider className="h-dvh overflow-hidden">
        <AppSidebar intent="inset" collapsible="dock" />
        <SidebarInset className="overflow-hidden">
          <AppSidebarNav />
          <div className="flex-1 overflow-auto p-4">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
    </BreadcrumbProvider>
  );
}

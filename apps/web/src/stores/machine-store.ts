import { create } from "zustand";

// Replaces the old local-mode `instance-store` (id/name/port/provider).
// The hub has no concept of ports or provider processes -- a "machine" is
// the unit of selection, identified by its hub-issued id, and every
// machine speaks the same opencode proxy API (`HubClient.opencode(id)`).
interface MachineState {
  selectedMachineId: string | null;
  setSelectedMachineId: (id: string | null) => void;
  clearSelectedMachineId: () => void;
}

export const useMachineStore = create<MachineState>()((set) => ({
  selectedMachineId: null,
  setSelectedMachineId: (id) => set({ selectedMachineId: id }),
  clearSelectedMachineId: () => set({ selectedMachineId: null }),
}));

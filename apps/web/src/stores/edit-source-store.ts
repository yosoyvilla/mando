import { create } from "zustand";

// A "source" the Images edit form can load without the user re-uploading a
// file -- either handed off from a session message's rendered image part
// (Task 3: session-image -> edit-in-Images) or, in principle, any other
// future producer of image bytes as a data URL. `dataUrl` is always a full
// `data:<mime>;base64,<payload>` string, matching lib/attachments.ts's
// `Attachment.dataUrl` shape.
export type PendingEditSource = {
  dataUrl: string;
  mime: string;
  filename: string;
};

interface EditSourceState {
  pendingEditSource: PendingEditSource | null;
  setPendingEditSource: (source: PendingEditSource) => void;
  // Reads AND clears the pending source in one step, so a later remount of
  // the Images page (or a plain refresh) never re-applies a stale source --
  // it is consumed exactly once, by whichever page mounts next.
  consumePendingEditSource: () => PendingEditSource | null;
}

// Deliberately NOT persisted (no zustand/persist middleware): this is a
// transient, same-session hand-off between two routes, not durable state --
// a page refresh losing it is the correct behavior, since the underlying
// session message is still right there to hand off again.
export const useEditSourceStore = create<EditSourceState>()((set, get) => ({
  pendingEditSource: null,
  setPendingEditSource: (source) => set({ pendingEditSource: source }),
  consumePendingEditSource: () => {
    const current = get().pendingEditSource;
    if (current) set({ pendingEditSource: null });
    return current;
  },
}));

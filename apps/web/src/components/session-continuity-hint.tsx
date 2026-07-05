import { useState } from "react";
import { Button } from "@/components/ui/button";
import { XMarkIcon } from "@/components/icons/lucide";

// One-time, dismissible note above the composer explaining the continuity
// model's single visible seam: a plain opencode terminal that is ALREADY
// open does not repaint when this session changes remotely (verified
// against opencode 1.17.13 -- its plain TUI only re-renders its own
// activity; the session data itself is shared and complete). Users coming
// back to their machine need to know to reopen the session there.
// Dismissal is persisted so the hint reads once, not forever -- same
// localStorage pattern as providers/theme-provider.tsx.
const STORAGE_KEY = "mando-hint-terminal-refresh";

function initiallyDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dismissed";
  } catch {
    // Storage unavailable (private mode restrictions): show the hint and
    // accept that dismissal will not persist.
    return false;
  }
}

export function SessionContinuityHint() {
  const [dismissed, setDismissed] = useState(initiallyDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "dismissed");
    } catch {
      // Best effort -- hiding for this visit is still correct.
    }
  };

  return (
    <div
      role="note"
      className="mb-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-fg"
    >
      <p className="flex-1">
        What you do here is saved to the same session your machine sees, but
        an already-open plain opencode terminal will not show it — run{" "}
        <code className="font-mono text-fg">/mando-refresh</code> there, or
        reopen the session there, when you switch back. Terminals started
        with <code className="font-mono text-fg">mando tui</code> mirror
        live.
      </p>
      <Button
        intent="plain"
        size="sq-xs"
        aria-label="Dismiss hint"
        onPress={dismiss}
        className="shrink-0"
      >
        <XMarkIcon className="size-4" />
      </Button>
    </div>
  );
}

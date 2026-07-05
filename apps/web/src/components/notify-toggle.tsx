import { useState } from "react";
import { BellIcon, BellOffIcon } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  isNotifyEnabled,
  requestNotifyPermission,
  setNotifyEnabled,
} from "@/lib/notify";

// Opt-in toggle for the browser Notification API (Task 9). Default off --
// enabling it is the one moment it is allowed to request OS permission
// (browsers block silent/background permission prompts). State persists in
// localStorage via lib/notify.ts, same pattern as
// providers/theme-provider.tsx's own STORAGE_KEY. Lives in the sidebar
// footer next to ThemeSwitcher (see app-sidebar.tsx).
export function NotifyToggle() {
  const [enabled, setEnabled] = useState(isNotifyEnabled);

  async function toggle() {
    if (enabled) {
      setNotifyEnabled(false);
      setEnabled(false);
      return;
    }

    const permission = await requestNotifyPermission();
    if (permission !== "granted") {
      toast.error("Browser notifications were not allowed");
      return;
    }

    setNotifyEnabled(true);
    setEnabled(true);
  }

  return (
    <Button
      intent="plain"
      size="sq-sm"
      onPress={toggle}
      aria-pressed={enabled}
      aria-label={
        enabled
          ? "Disable run and approval notifications"
          : "Enable run and approval notifications"
      }
    >
      {enabled ? (
        <BellIcon className="size-4" />
      ) : (
        <BellOffIcon className="size-4" />
      )}
    </Button>
  );
}

// Browser Notification API integration for the "notify me" toggle (Task
// 9): a run finishing or a permission request landing while the tab is in
// the background. Deliberately thin -- no service worker, no push, the
// tab must stay open. Opt-in, default off, and gated on the OS-level
// permission the toggle requests when the user turns it on.
const STORAGE_KEY = "mando-notify-enabled";

export type Notifier = (title: string, options?: NotificationOptions) => void;

function defaultNotifier(title: string, options?: NotificationOptions): void {
  if (typeof Notification === "undefined") return;

  const notification = new Notification(title, options);
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

// Test-only seam -- production code never calls this; it exists so unit
// tests can observe calls without triggering a real OS notification.
let notifier: Notifier = defaultNotifier;

export function setNotifier(fn: Notifier): void {
  notifier = fn;
}

export function resetNotifier(): void {
  notifier = defaultNotifier;
}

export function isNotifySupported(): boolean {
  return typeof Notification !== "undefined";
}

export function isNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Storage unavailable (private mode restrictions): treat as disabled.
    return false;
  }
}

export function setNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Best effort -- the in-memory toggle state still reflects the choice
    // for this visit even if it will not persist across reloads.
  }
}

export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!isNotifySupported()) return "denied";
  return Notification.requestPermission();
}

// Called unconditionally from the SSE dispatch on `session.idle` /
// `permission.asked` -- all the opt-in/permission/visibility gating lives
// here so the dispatch site stays a one-line call. Only fires when the tab
// is in the background (`document.hidden`): an already-focused tab does
// not need an OS-level alert on top of its own UI update.
export function notifyIfBackgrounded(
  title: string,
  options?: NotificationOptions,
): void {
  if (!isNotifyEnabled()) return;
  if (!isNotifySupported() || Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;

  notifier(title, options);
}

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  isNotifyEnabled,
  setNotifyEnabled,
  notifyIfBackgrounded,
  setNotifier,
  resetNotifier,
} from "../src/lib/notify";

const STORAGE_KEY = "mando-notify-enabled";

function stubNotificationPermission(permission: NotificationPermission) {
  (globalThis as { Notification?: unknown }).Notification = {
    permission,
    requestPermission: mock(() => Promise.resolve(permission)),
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    value: hidden,
    configurable: true,
  });
}

describe("lib/notify", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    setHidden(true);
    stubNotificationPermission("granted");
  });

  afterEach(() => {
    resetNotifier();
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it("defaults to disabled and persists enabling", () => {
    expect(isNotifyEnabled()).toBe(false);

    setNotifyEnabled(true);
    expect(isNotifyEnabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("persists disabling", () => {
    setNotifyEnabled(true);
    setNotifyEnabled(false);
    expect(isNotifyEnabled()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });

  it("does not notify when disabled, even if hidden and permitted", () => {
    const notifier = mock(() => {});
    setNotifier(notifier);
    setNotifyEnabled(false);

    notifyIfBackgrounded("Run finished");

    expect(notifier).not.toHaveBeenCalled();
  });

  it("does not notify when the tab is visible, even if enabled", () => {
    const notifier = mock(() => {});
    setNotifier(notifier);
    setNotifyEnabled(true);
    setHidden(false);

    notifyIfBackgrounded("Run finished");

    expect(notifier).not.toHaveBeenCalled();
  });

  it("does not notify when OS permission was not granted", () => {
    const notifier = mock(() => {});
    setNotifier(notifier);
    setNotifyEnabled(true);
    stubNotificationPermission("denied");

    notifyIfBackgrounded("Run finished");

    expect(notifier).not.toHaveBeenCalled();
  });

  it("notifies when enabled, hidden, and permitted", () => {
    const notifier = mock(() => {});
    setNotifier(notifier);
    setNotifyEnabled(true);

    notifyIfBackgrounded("Run finished", { tag: "t1" });

    expect(notifier).toHaveBeenCalledWith("Run finished", { tag: "t1" });
  });
});

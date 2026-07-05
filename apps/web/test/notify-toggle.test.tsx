import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotifyToggle } from "../src/components/notify-toggle";
import { isNotifyEnabled } from "../src/lib/notify";

const STORAGE_KEY = "mando-notify-enabled";

function stubNotificationPermission(
  requestPermission: () => Promise<NotificationPermission>,
) {
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission,
  };
}

describe("NotifyToggle", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it("renders off by default", () => {
    render(<NotifyToggle />);
    expect(
      screen.getByRole("button", {
        name: "Enable run and approval notifications",
      }),
    ).toBeTruthy();
  });

  it("requests permission and persists enabling when granted", async () => {
    stubNotificationPermission(() => Promise.resolve("granted"));
    render(<NotifyToggle />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Enable run and approval notifications",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Disable run and approval notifications",
        }),
      ).toBeTruthy();
    });
    expect(isNotifyEnabled()).toBe(true);
  });

  it("does not enable when the browser permission prompt is denied", async () => {
    stubNotificationPermission(() => Promise.resolve("denied"));
    render(<NotifyToggle />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Enable run and approval notifications",
      }),
    );

    await waitFor(() => expect(isNotifyEnabled()).toBe(false));
    expect(
      screen.getByRole("button", {
        name: "Enable run and approval notifications",
      }),
    ).toBeTruthy();
  });

  it("disables and persists without re-requesting permission", async () => {
    stubNotificationPermission(() => Promise.resolve("granted"));
    render(<NotifyToggle />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Enable run and approval notifications",
      }),
    );
    await waitFor(() => expect(isNotifyEnabled()).toBe(true));

    const requestPermission = mock(() => Promise.resolve("granted" as NotificationPermission));
    stubNotificationPermission(requestPermission);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Disable run and approval notifications",
      }),
    );

    await waitFor(() => expect(isNotifyEnabled()).toBe(false));
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

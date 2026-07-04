import { test, expect } from "@playwright/test";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  HUB_BASE_URL,
  MACHINE_NAME,
} from "../harness-config";
import { loginForCookie } from "../fixtures/hub-api";
import { bringMachineOnline, waitForMachineOnline } from "../fixtures/machine-lifecycle";
import { login } from "../fixtures/ui-helpers";

// Drives apps/web/src/components/machine-picker.tsx against the real hub.
//
// The "online -> offline" and "revoke" tests each pair and connect their
// *own* dedicated machine via bringMachineOnline() (the same seed-then-
// `mando connect` shortcut global-setup.ts uses for the harness's shared
// e2e-machine -- see task-8.1-report.md) rather than touching the shared
// harness machine: killing that daemon or revoking that machine would
// leave it offline/gone for every spec file that runs afterwards
// (session-drive.spec.ts, isolation.spec.ts), since global-setup.ts's boot
// sequence runs exactly once for the whole suite. Each test tears its own
// machine down in a `finally`, independent of whether assertions passed.
test.describe("machines", () => {
  test("the harness's online machine shows an online badge", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/machines");

    const card = page.getByRole("listitem").filter({ hasText: MACHINE_NAME });
    await expect(card).toBeVisible();
    await expect(card.getByText("Online", { exact: true })).toBeVisible();
  });

  test("stopping a machine's agent flips its badge to offline", async ({ page }) => {
    const machineName = `e2e-offline-test-${crypto.randomUUID().slice(0, 8)}`;
    const machine = await bringMachineOnline(machineName, HUB_BASE_URL, ADMIN_EMAIL);

    try {
      const cookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
      await waitForMachineOnline(HUB_BASE_URL, cookie, machineName);

      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/machines");
      const card = page.getByRole("listitem").filter({ hasText: machineName });
      await expect(card.getByText("Online", { exact: true })).toBeVisible();

      await machine.stop();

      // The picker only fetches on mount (no polling loop) -- a reload is
      // the real-world equivalent of a user coming back to the page after
      // their machine dropped off the tunnel.
      await page.reload();
      await expect(card.getByText("Offline", { exact: true })).toBeVisible();
    } finally {
      await machine.stop();
    }
  });

  test("revoking a machine from the UI removes it from the list", async ({ page }) => {
    const machineName = `e2e-revoke-test-${crypto.randomUUID().slice(0, 8)}`;
    const machine = await bringMachineOnline(machineName, HUB_BASE_URL, ADMIN_EMAIL);

    try {
      const cookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
      await waitForMachineOnline(HUB_BASE_URL, cookie, machineName);

      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
      await page.goto("/machines");
      const card = page.getByRole("listitem").filter({ hasText: machineName });
      await expect(card).toBeVisible();

      await card.getByRole("button", { name: `Revoke ${machineName}` }).click();
      await expect(card).not.toBeVisible();

      // Server-side confirmation, independent of the client-side filter:
      // the revoked machine's tunnel connection was actually dropped, not
      // just hidden in the UI (see machines/routes.ts's POST /revoke,
      // which removes the live registry entry before closing the socket).
      const res = await page.request.get(`${HUB_BASE_URL}/api/v1/machines`);
      const body = (await res.json()) as {
        machines: Array<{ name: string; online: boolean; revokedAt: string | null }>;
      };
      const revoked = body.machines.find((m) => m.name === machineName);
      expect(revoked?.revokedAt).not.toBeNull();
      expect(revoked?.online).toBe(false);
    } finally {
      await machine.stop();
    }
  });
});

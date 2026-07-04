import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, MACHINE_NAME } from "../harness-config";
import { inviteUser } from "../fixtures/hub-api";
import { login } from "../fixtures/ui-helpers";

// Cross-user isolation. User B is created via POST /api/v1/auth/invite
// (requires an authenticated admin -- see apps/hub/src/users/routes.ts;
// POST /api/v1/auth/bootstrap only works while zero users exist, which is
// already false by the time any spec runs) rather than through a web UI
// invite flow, because there isn't one -- the SPA has no invite screen,
// only the API endpoint. The invite response's `tempPassword` is what a
// real invited user would receive out-of-band and use for their first
// login, so logging in with it through the real LoginView is still an
// end-to-end check of the *login* half of isolation.
//
// "Direct navigation to A's machine session URL" (per the task brief) has
// no literal web route to drive: apps/web's router has no
// /machines/:id or /session/:machineId/:sessionId path -- machine
// selection is purely a client-side Zustand store
// (stores/machine-store.ts), never encoded in a URL. The closest faithful
// check is hitting the hub's own machine-scoped REST routes directly
// (GET /api/v1/machines/:id and the opencode proxy under it) as user B --
// both are gated by the same requireMachineOwnership middleware the web
// app's HubClient calls through, and both fold "not yours" into the same
// 404 as "doesn't exist" (see apps/hub/src/auth/middleware.ts).
test.describe("isolation", () => {
  test("user B never sees user A's machine and cannot reach it via the API", async ({
    page,
    browser,
  }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const machinesRes = await page.request.get(`${HUB_BASE_URL}/api/v1/machines`);
    const machinesBody = (await machinesRes.json()) as {
      machines: Array<{ id: string; name: string }>;
    };
    const adminMachine = machinesBody.machines.find((m) => m.name === MACHINE_NAME);
    expect(adminMachine).toBeTruthy();
    const adminMachineId = adminMachine!.id;

    const userBEmail = `e2e-user-b-${crypto.randomUUID().slice(0, 8)}@mando.test`;
    const { tempPassword } = await inviteUser(HUB_BASE_URL, await adminSessionCookie(page), userBEmail);

    const userBContext = await browser.newContext();
    const userBPage = await userBContext.newPage();
    try {
      await login(userBPage, userBEmail, tempPassword);

      await userBPage.goto("/machines");
      await expect(
        userBPage.getByRole("listitem").filter({ hasText: MACHINE_NAME }),
      ).not.toBeVisible();
      // The picker only ever shows user B's own (empty) machine list -- the
      // no-machines empty state, not a "0 of N filtered" state.
      await expect(userBPage.getByText("No machines paired yet")).toBeVisible();

      const directRes = await userBPage.request.get(
        `${HUB_BASE_URL}/api/v1/machines/${adminMachineId}`,
      );
      expect(directRes.status()).toBe(404);

      const proxyRes = await userBPage.request.get(
        `${HUB_BASE_URL}/api/v1/machines/${adminMachineId}/opencode/sessions`,
      );
      expect(proxyRes.status()).toBe(404);
    } finally {
      await userBContext.close();
    }
  });
});

// page.request shares the browsing context's cookie jar, so once `login`
// has run there's already a `mando_sess` cookie sitting in the context --
// this just reads it back out in the `Cookie:` header shape inviteUser()
// expects, instead of logging in a second time via a separate fetch.
async function adminSessionCookie(page: import("@playwright/test").Page): Promise<string> {
  const cookies = await page.context().cookies(HUB_BASE_URL);
  const session = cookies.find((cookie) => cookie.name === "mando_sess");
  if (!session) throw new Error("admin session cookie not found -- was login() called first?");
  return `mando_sess=${session.value}`;
}

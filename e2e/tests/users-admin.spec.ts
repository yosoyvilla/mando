import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL } from "../harness-config";
import { inviteUser, loginForCookie } from "../fixtures/hub-api";
import { login } from "../fixtures/ui-helpers";

// Drives apps/web/src/routes/_app/users.tsx (the admin-only Users page) and
// its nav gating in apps/web/src/components/app-sidebar.tsx (SidebarItem
// only renders when `user.isAdmin`) against the real hub -- no mocked
// HubClient. GET /api/v1/users, POST /api/v1/auth/invite (via the page's
// "Invite a user" form) and the isAdmin flag on /me/login/bootstrap
// (apps/hub/src/users/routes.ts) are all exercised end-to-end here.
test.describe("users admin", () => {
  test("admin sees the Users nav item and it opens the page", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const usersLink = page.getByRole("link", { name: "Users" });
    await expect(usersLink).toBeVisible();
    await usersLink.click();

    await expect(page).toHaveURL(/\/users/);
    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
    await expect(page.getByRole("form", { name: "Invite a user" })).toBeVisible();
  });

  test("admin creates a user, sees the one-time temp password, and the user appears in the list", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/users");

    const newUserEmail = `e2e-created-${Date.now()}@mando.test`;
    const inviteForm = page.getByRole("form", { name: "Invite a user" });
    await inviteForm.getByLabel("Email").fill(newUserEmail);
    // exact: true -- this hub's Postgres persists across e2e runs (see
    // global-setup.ts's retention log), so by the time this spec runs the
    // "All users" list already has plenty of rows whose "Delete user:
    // <email>" accessible name contains "invite" as a case-insensitive
    // substring (e.g. an email starting with "inviter-"). A non-exact
    // match on "Invite" resolves to those too.
    await inviteForm.getByRole("button", { name: "Invite", exact: true }).click();

    // The temp password panel is shown exactly once (see UsersAdmin's
    // createdUser state, never re-fetched) -- assert on the specific text
    // it renders, not just any success signal.
    await expect(page.getByText(`Temporary password for ${newUserEmail}:`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();

    // load() re-runs after a successful create, so the new user shows up in
    // "All users" without a manual reload. Scoped to the list specifically
    // -- the temp password panel above also renders the same email in a
    // <strong>, which would otherwise make this a strict-mode violation.
    await expect(page.getByRole("list").getByText(newUserEmail, { exact: true })).toBeVisible();
  });

  test("a non-admin invited user does not see the Users nav item and is redirected away from /users", async ({
    page,
    browser,
  }) => {
    const adminCookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const inviteeEmail = `e2e-non-admin-${Date.now()}@mando.test`;
    const { tempPassword } = await inviteUser(HUB_BASE_URL, adminCookie, inviteeEmail);

    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    try {
      await login(userPage, inviteeEmail, tempPassword);

      await expect(userPage.getByRole("link", { name: "Users" })).not.toBeVisible();

      // routes/_app/users.tsx's admin gate renders <Navigate to="/" /> for a
      // non-admin `user` -- direct navigation should bounce straight back
      // off of /users rather than rendering the page.
      await userPage.goto("/users");
      await expect(userPage).not.toHaveURL(/\/users/);
    } finally {
      await userContext.close();
    }
  });
});

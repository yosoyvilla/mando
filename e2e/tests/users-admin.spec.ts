import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL } from "../harness-config";
import { inviteUser, loginForCookie } from "../fixtures/hub-api";
import { login, logout } from "../fixtures/ui-helpers";

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

  // Drives PATCH /api/v1/users/:id via handleToggleAdmin's "Make admin"
  // path (apps/hub/src/users/routes.ts, apps/web/src/lib/hub-client.ts's
  // setUserAdmin). The invited throwaway user is never logged into here --
  // only the acting ADMIN_EMAIL session drives the UI -- so this cannot
  // touch the harness admin's own credentials.
  test("admin promotes an invited user to admin via the Users page", async ({ page }) => {
    const adminCookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const promoteeEmail = `e2e-promote-${crypto.randomUUID().slice(0, 8)}@mando.test`;
    await inviteUser(HUB_BASE_URL, adminCookie, promoteeEmail);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/users");

    // Scoped to this user's own row (a random UUID-suffixed email, so no
    // substring collision with other rows) rather than a page-wide
    // getByRole lookup -- the "Make admin"/"Remove admin" aria-label is
    // shared across every row in "All users".
    const row = page.getByRole("listitem").filter({ hasText: promoteeEmail });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Make admin: ${promoteeEmail}`, exact: true }).click();

    // handleToggleAdmin's load() re-fetch (apps/web/src/routes/_app/users.tsx)
    // flips the same row to "Remove admin" and renders the Admin badge --
    // both are asserted so the promotion is reflected in both the action
    // button and the visible role indicator, not just one of the two.
    await expect(
      row.getByRole("button", { name: `Remove admin: ${promoteeEmail}`, exact: true }),
    ).toBeVisible();
    await expect(row.getByText("Admin", { exact: true })).toBeVisible();
  });
});

// Drives POST /api/v1/me/password via ChangePassword
// (apps/web/src/components/change-password.tsx) against the Settings >
// Account tab, then re-verifies through the real LoginView that the new
// password works and the old temp password no longer does. Only ever
// touches a freshly-invited throwaway user's password -- never
// ADMIN_EMAIL/ADMIN_PASSWORD, which other specs and global-setup rely on
// staying constant across the whole run.
test.describe("password change", () => {
  test("a user changes their own password via Settings > Account, then must use the new one", async ({
    page,
  }) => {
    const adminCookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    const email = `e2e-pw-change-${crypto.randomUUID().slice(0, 8)}@mando.test`;
    const { tempPassword } = await inviteUser(HUB_BASE_URL, adminCookie, email);
    const newPassword = `e2e-new-pw-${crypto.randomUUID().slice(0, 8)}`;

    await login(page, email, tempPassword);
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Account" }).click();

    const form = page.getByRole("form", { name: "Change password" });
    // exact: true -- "New password" is otherwise a case-insensitive
    // substring of the "Confirm new password" label, which would make an
    // unscoped getByLabel("New password") a strict-mode violation.
    await form.getByLabel("Current password", { exact: true }).fill(tempPassword);
    await form.getByLabel("New password", { exact: true }).fill(newPassword);
    await form.getByLabel("Confirm new password", { exact: true }).fill(newPassword);
    await form.getByRole("button", { name: "Change password", exact: true }).click();

    // ChangePassword's `changed` state renders this exact status text (see
    // change-password.tsx) -- assert on it specifically, not just any
    // success-shaped signal.
    await expect(page.getByRole("status")).toHaveText(
      "Password changed. Your other sessions have been signed out.",
    );

    await logout(page);

    // New password works. This throwaway user has no machines paired, so
    // the default post-login destination ("/", per
    // apps/web/src/lib/safe-redirect.ts) bounces through
    // ConnectedAppLayout's "/machines" fallback (routes/_app.tsx) --
    // that's a standalone route (routes/machines.tsx) rendered outside the
    // AppSidebar-bearing `/_app` layout entirely, so it has no Profile
    // button. /settings is one of the MACHINE_INDEPENDENT_PATHS, so it
    // renders the full authenticated shell regardless of machine count --
    // use it as the "login actually succeeded" signal instead.
    await login(page, email, newPassword);
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "Profile" })).toBeVisible();
    await logout(page);

    // Old temp password is rejected -- drive the login form directly (not
    // via the `login` helper, which asserts success) and confirm the
    // real-hub error path fires and the user stays on /login.
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(tempPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

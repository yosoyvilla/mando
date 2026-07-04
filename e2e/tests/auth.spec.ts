import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";
import { login, logout } from "../fixtures/ui-helpers";

// Drives apps/web/src/components/login-view.tsx (email/password form),
// apps/web/src/components/require-auth.tsx (the redirect gate), and
// apps/web/src/components/app-sidebar.tsx (the logout menu item) against
// the real hub -- no mocked HubClient.
test.describe("auth", () => {
  test("wrong password shows an error and stays logged out", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // Still unauthenticated: a protected route bounces right back.
    await page.goto("/machines");
    await expect(page).toHaveURL(/\/login/);
  });

  test("correct credentials log in and land in the app", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // AppLayout (routes/_app.tsx) auto-selects the seeded online machine
    // and renders the sidebar once authenticated -- a stable signal that
    // login actually reached the authenticated app shell, not just some
    // other non-/login page.
    await expect(page.getByRole("button", { name: "Profile" })).toBeVisible();
  });

  test("logout returns to the login page", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await logout(page);

    await expect(page.getByRole("heading", { name: "Mando" })).toBeVisible();
    // A subsequent protected-route visit should require login again --
    // logout really cleared the session cookie, not just the client state.
    await page.goto("/machines");
    await expect(page).toHaveURL(/\/login/);
  });

  test("visiting a protected route while logged out redirects to /login", async ({ page }) => {
    await page.goto("/machines");
    await expect(page).toHaveURL(/\/login\?redirect=/);
    await expect(page.getByRole("heading", { name: "Mando" })).toBeVisible();
  });
});

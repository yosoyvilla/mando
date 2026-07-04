import { test, expect } from "@playwright/test";

// Proves the harness itself works: Postgres is up, the web SPA is built,
// the real hub entry point (apps/hub/src/index.ts) served it, and an
// unauthenticated visitor lands on the login form. Task 8.2 adds specs
// that actually log in, drive a session, and exercise the seeded/online
// machine global-setup.ts brings up.
test("harness boots: unauthenticated visitor sees the login page", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Mando" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
});

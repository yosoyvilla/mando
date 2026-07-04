// Small drive-the-real-UI helpers shared across spec files. Kept out of
// individual specs so the login/logout flow -- which several specs need
// purely as setup, not as the thing under test -- has exactly one place to
// update if login-view.tsx's markup ever changes.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// Fills and submits the real login form (see
// apps/web/src/components/login-view.tsx) and waits for the redirect away
// from /login that a successful login triggers. Callers that expect
// login to fail should drive the form directly instead of using this.
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

// Opens the sidebar profile menu and clicks "Log out" (see
// apps/web/src/components/app-sidebar.tsx).
export async function logout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Profile" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

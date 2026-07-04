import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";
import { login } from "../fixtures/ui-helpers";

// Drives apps/web/src/providers/theme-provider.tsx (localStorage-backed
// theme state, applied via a `dark` class on <html>) through the real
// switcher UI (apps/web/src/components/theme-switcher.tsx -- a Menu whose
// trigger's aria-label is "Theme: <theme>. Change theme" and whose items
// are plain menuitems "Light"/"Dark"/"System"), asserting the choice both
// takes effect immediately and survives a reload (localStorage
// persistence), without leaving the rest of the UI broken.
//
// The switcher only renders inside AppSidebar's footer (app-sidebar.tsx),
// which is part of the `_app` layout used by the session screens -- not
// the standalone /machines route (see mobile-responsive.spec.ts) -- so this
// test creates a session first, same as session-drive.spec.ts.
test.describe("dark mode", () => {
  test("choosing Dark applies the class, persists across reload, and the app still renders", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\//);

    await page.getByRole("button", { name: /^Theme:.*Change theme$/ }).click();
    await page.getByRole("menuitem", { name: "Dark" }).click();

    await expect(page.locator("html")).toHaveClass(/dark/);

    await page.reload();

    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(
      page.getByRole("button", { name: /^Theme: dark\. Change theme$/ }),
    ).toBeVisible();
    // The rest of the screen still renders normally in dark mode, not just
    // the sidebar footer we just clicked in.
    await expect(
      page.getByPlaceholder("Type your message... (use @ to mention files)"),
    ).toBeVisible();
  });
});

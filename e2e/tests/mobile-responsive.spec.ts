import { test, expect, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";
import { login } from "../fixtures/ui-helpers";

// Guards Feature A (mobile responsiveness) against regressions. Two things
// broke before that fix, found by manual multi-viewport recon:
//
//   1. The sidebar (ui/sidebar.tsx) renders as a Sheet drawer on phone
//      (isMobile branch) but nothing closed it after navigating -- opening
//      or creating a session left the drawer covering the chat/composer.
//      app-sidebar.tsx now closes it on every route change.
//   2. The PULL/PUSH/CREATE PR buttons (app-sidebar-nav.tsx) render their
//      full text label at all widths, which only barely fit at 390px in
//      the default label state and overflow once a button's label grows
//      ("Pulling...", "Creating..."). They're icon-only below `sm` now.
//
// This test asserts the externally-observable contract those fixes rely
// on -- no horizontal overflow at phone width on the two screens that
// matter most (machines, session), and the sidebar renders as a mobile
// trigger + drawer on phone but as the persistent container on desktop --
// without depending on exact pixel sizes, so it stays stable across
// unrelated visual tweaks.
async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  // Small tolerance for scrollbar-width rounding, not a loophole for real
  // overflow (a genuinely overflowing element is tens of pixels wide).
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

test.describe("mobile responsiveness", () => {
  test("phone viewport (390px): no horizontal overflow, drawer trigger visible, drawer closes on navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // Machines screen (routes/machines.tsx -- outside the `_app` layout,
    // so no sidebar here at all; just the responsive grid from
    // machine-picker.tsx).
    await page.goto("/machines");
    await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Session screen (routes/_app/session/$id.tsx -- inside the `_app`
    // layout, which renders AppSidebar). On phone, AppSidebar's contents
    // (including the "New Session" button) live inside the closed Sheet
    // drawer, not the persistent container -- open it via the hamburger
    // trigger first, same as a real phone user would.
    await page.goto("/");
    const trigger = page.locator('[data-slot="sidebar-trigger"]').first();
    await expect(trigger).toBeVisible();
    await expect(page.locator('[data-slot="sidebar-container"]')).toHaveCount(0);
    await trigger.click();
    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\//);
    await assertNoHorizontalOverflow(page);

    // Open the drawer, then navigate via a real link inside it (Diff) --
    // this is the exact path that used to leave the drawer stuck open on
    // top of the destination screen.
    await page.locator('[data-slot="sidebar-trigger"]').first().click();
    const drawer = page.locator('[role="dialog"][aria-label="Sidebar"]');
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "Diff" }).click();
    await expect(page).toHaveURL(/\/diff/);
    await expect(drawer).not.toBeVisible();
    // The Diff view fetches `/vcs/diff/raw` (see use-opencode.ts's
    // `useGitDiff`) -- assert it actually loads (heading renders, no error
    // state) rather than just checking the URL, so a regression back to a
    // non-existent endpoint or a response-shape mismatch fails here too.
    await expect(page.getByRole("heading", { name: "Git Diff" })).toBeVisible();
    await expect(page.getByText("Error loading diff")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });

  test("desktop viewport (1280px): persistent sidebar is used, not the mobile drawer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\//);

    await expect(page.locator('[data-slot="sidebar-container"]')).toBeVisible();
    await expect(page.locator('[role="dialog"][aria-label="Sidebar"]')).toHaveCount(0);
  });
});

// Standalone screenshot capture for a human design review of the dark-mode
// / visual-identity work, run directly (`bun e2e/scripts/capture-review-
// screenshots.ts` from `e2e/`) -- NOT part of the Playwright test suite and
// NOT the README assets (see capture-screenshots.ts for those; this script
// writes elsewhere and is not wired into any doc). Kept out of e2e/tests/
// for the same reason as capture-screenshots.ts: `bunx playwright test`'s
// default testMatch would otherwise pick it up.
//
// Reuses the exact same real-stack boot sequence as the E2E suite by
// importing and calling e2e/global-setup.ts's default export directly, then
// drives real Chromium browser contexts (via @playwright/test's `chromium`,
// not the Playwright *test runner*) through light/dark variants of the
// machines and session screens, plus the login screen in dark and the
// session screen at phone width in dark, saving each as a PNG under
// .superpowers/sdd/review-shots/.
//
// Run from e2e/: `bun scripts/capture-review-screenshots.ts`
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import globalSetup from "../global-setup";
import { login } from "../fixtures/ui-helpers";
import { REPO_ROOT } from "../fixtures/machine-lifecycle";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, MACHINE_NAME } from "../harness-config";

const OUT_DIR = join(REPO_ROOT, ".superpowers/sdd/review-shots");

// localStorage key theme-provider.tsx persists the chosen theme under (see
// apps/web/src/providers/theme-provider.tsx's STORAGE_KEY) -- seeding it via
// an init script before the app's first script runs is more reliable than
// clicking through the theme-switcher menu on every single page, and is
// exactly what the provider itself reads on mount.
const THEME_STORAGE_KEY = "intentui-theme";

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const DEVICE_SCALE_FACTOR = 2;

const REVIEW_PROMPT = "Summarize the changes in this branch";
const REVIEW_REPLY =
  "This branch adds dark mode (a theme provider + switcher persisted to " +
  "localStorage), refines the visual identity (typography, spacing, " +
  "color tokens), and fills in functional and accessibility states across " +
  "the machines, session, and pairing screens.";

// Same rationale as capture-screenshots.ts: Locator.waitFor() only checks
// visibility, not text content, and expect(...).toContainText() needs the
// test-fixture `expect`, which throws outside a `test()` block. Poll by
// hand instead since this script drives Chromium directly.
async function waitForText(locator: Locator, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await locator.textContent().catch(() => null);
    if (text?.includes(expected)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for text "${expected}" (last seen: ${JSON.stringify(text)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function newContext(
  browser: Browser,
  opts: { viewport: { width: number; height: number }; theme: "light" | "dark" },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: HUB_BASE_URL,
    viewport: opts.viewport,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: opts.theme,
  });
  // Runs before any page script on every document in this context, so the
  // ThemeProvider's initial useState read of localStorage picks this up on
  // the very first render -- no UI interaction or reload required.
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [THEME_STORAGE_KEY, opts.theme],
  );
  return context;
}

// Selects the (already online) harness machine and creates + drives a
// session so the capture shows a real exchange, not an empty composer.
// `openMobileDrawer` mirrors mobile-responsive.spec.ts: on phone width the
// sidebar (and its "New Session" entry) lives inside a closed Sheet drawer
// that must be opened via the hamburger trigger first.
async function driveSession(page: Page, opts: { openMobileDrawer: boolean }): Promise<void> {
  await page.goto("/");
  if (opts.openMobileDrawer) {
    await page.locator('[data-slot="sidebar-trigger"]').first().click();
  }
  await page.getByTestId("new-session").click();
  await page.waitForURL(/\/session\//);

  await page.getByPlaceholder("Type your message... (use @ to mention files)").fill(REVIEW_PROMPT);
  await page.getByRole("button", { name: "Send message" }).click();

  const assistantMessage = page.getByTestId("assistant-message").last();
  await waitForText(assistantMessage, REVIEW_REPLY.slice(-40));
}

async function captureMachines(page: Page, outPath: string): Promise<void> {
  await page.goto("/machines");
  const card = page.getByRole("listitem").filter({ hasText: MACHINE_NAME });
  await card.getByText("Online", { exact: true }).waitFor({ state: "visible" });
  await page.screenshot({ path: outPath });
}

function assertNonTrivial(path: string): void {
  const { size } = statSync(path);
  if (size < 10_000) {
    throw new Error(`${path} is only ${size} bytes -- looks blank/broken`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Same trick as capture-screenshots.ts: a fixed reply from the stub so
  // every captured exchange reads naturally instead of showing raw prompt
  // echoes.
  process.env.MANDO_STUB_REPLY = REVIEW_REPLY;

  console.log("Booting harness (postgres, web build, hub, stub opencode, online machine)...");
  const teardown = await globalSetup({} as Parameters<typeof globalSetup>[0]);

  const browser = await chromium.launch();
  const shots: string[] = [];
  try {
    // Desktop light.
    {
      const context = await newContext(browser, { viewport: DESKTOP_VIEWPORT, theme: "light" });
      const page = await context.newPage();
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      const machinesPath = join(OUT_DIR, "machines-light.png");
      await captureMachines(page, machinesPath);
      shots.push(machinesPath);
      console.log("Captured machines-light.png");

      await driveSession(page, { openMobileDrawer: false });
      const sessionPath = join(OUT_DIR, "session-light.png");
      await page.screenshot({ path: sessionPath });
      shots.push(sessionPath);
      console.log("Captured session-light.png");

      await context.close();
    }

    // Desktop dark.
    {
      const context = await newContext(browser, { viewport: DESKTOP_VIEWPORT, theme: "dark" });
      const page = await context.newPage();

      await page.goto("/login");
      await page.getByLabel("Password").waitFor({ state: "visible" });
      const loginPath = join(OUT_DIR, "login-dark.png");
      await page.screenshot({ path: loginPath });
      shots.push(loginPath);
      console.log("Captured login-dark.png");

      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      const machinesPath = join(OUT_DIR, "machines-dark.png");
      await captureMachines(page, machinesPath);
      shots.push(machinesPath);
      console.log("Captured machines-dark.png");

      await driveSession(page, { openMobileDrawer: false });
      const sessionPath = join(OUT_DIR, "session-dark.png");
      await page.screenshot({ path: sessionPath });
      shots.push(sessionPath);
      console.log("Captured session-dark.png");

      await context.close();
    }

    // Phone dark.
    {
      const context = await newContext(browser, { viewport: PHONE_VIEWPORT, theme: "dark" });
      const page = await context.newPage();
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      await driveSession(page, { openMobileDrawer: true });
      const sessionPhonePath = join(OUT_DIR, "session-phone-dark.png");
      await page.screenshot({ path: sessionPhonePath });
      shots.push(sessionPhonePath);
      console.log("Captured session-phone-dark.png");

      await context.close();
    }

    for (const shot of shots) assertNonTrivial(shot);
  } finally {
    await browser.close().catch(() => {});
    await teardown();
  }
}

void main()
  .then(() => {
    console.log(`Done. Review screenshots written to ${OUT_DIR}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });

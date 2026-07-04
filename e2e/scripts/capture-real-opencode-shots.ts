// Standalone screenshot capture proving the web UI renders REAL opencode data
// correctly (real machine list, a real terminal session opened + a real user
// message), run directly (`bun scripts/capture-real-opencode-shots.ts` from
// `e2e/`) -- NOT part of the Playwright test suite. It is the real-opencode
// counterpart to capture-review-screenshots.ts (which drives the in-process
// STUB): instead of importing global-setup.ts it imports global-setup-real.ts,
// which boots a genuine `opencode serve`, brings a machine online through the
// hub -> agent -> real opencode path, and creates a "terminal" session by
// hitting real opencode directly. The handoff state (machine name, real
// session id) is read back from REAL_HANDOFF_STATE_FILE, exactly like the
// gated real-opencode-browser-handoff.spec.ts does.
//
// Kept in e2e/scripts/ (not e2e/tests/) so neither the default nor the real
// Playwright config's testMatch picks it up -- it runs standalone.
//
// Output: .superpowers/sdd/real-ui-shots/ (TEMP, gitignored -- NOT the README
// assets). Run from e2e/: `bun scripts/capture-real-opencode-shots.ts`
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import globalSetupReal from "../global-setup-real";
import { login } from "../fixtures/ui-helpers";
import { REPO_ROOT } from "../fixtures/machine-lifecycle";
import { REAL_HANDOFF_STATE_FILE, type RealHandoffState } from "../fixtures/real-opencode";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL } from "../harness-config";

const OUT_DIR = join(REPO_ROOT, ".superpowers/sdd/real-ui-shots");

// Same persisted-theme key theme-provider.tsx reads on mount (see
// apps/web/src/providers/theme-provider.tsx's STORAGE_KEY) -- seeding it via an
// init script before the app's first script runs is more reliable than clicking
// the theme switcher on every page.
const THEME_STORAGE_KEY = "intentui-theme";

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const DEVICE_SCALE_FACTOR = 2;

function loadState(): RealHandoffState {
  return JSON.parse(readFileSync(REAL_HANDOFF_STATE_FILE, "utf8")) as RealHandoffState;
}

// Locator.waitFor() only checks visibility, not text content, and the
// test-fixture `expect` throws outside a `test()` block -- so poll by hand,
// same as capture-review-screenshots.ts.
async function waitForText(locator: Locator, expected: string, timeoutMs = 15_000): Promise<void> {
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
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [THEME_STORAGE_KEY, opts.theme],
  );
  return context;
}

// Captures the machines list, asserting the REAL machine shows Online first so
// the shot is never a half-loaded page.
async function captureMachines(page: Page, machineName: string, outPath: string): Promise<void> {
  await page.goto("/machines");
  const card = page.getByRole("listitem").filter({ hasText: machineName });
  await card.getByText("Online", { exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: outPath });
}

// Opens the REAL terminal session (created directly against opencode in
// global-setup-real.ts) by its exact id via the sidebar link -- matching the
// handoff spec, never by title/position -- then sends a prompt so a real user
// message renders. The app auto-selects the only online machine, so no explicit
// machine pick is needed. No assistant reply is expected (no provider
// configured), mirroring the gated spec. `openMobileDrawer` opens the sidebar
// Sheet on phone width, where the session list lives behind the hamburger.
async function openRealSessionAndPrompt(
  page: Page,
  sessionId: string,
  opts: { openMobileDrawer: boolean },
): Promise<void> {
  await page.goto("/");
  if (opts.openMobileDrawer) {
    await page.locator('[data-slot="sidebar-trigger"]').first().click();
  }

  // On phone width both the main content list and the open sidebar drawer
  // render a link to the session, and the open drawer overlays (and so
  // intercepts clicks to) the main content -- so scope to the Sidebar region,
  // whose link is the one actually on top and clickable.
  const linkScope = opts.openMobileDrawer ? page.getByLabel("Sidebar", { exact: true }) : page;
  const sessionLink = linkScope.locator(`a[href="/session/${sessionId}"]`).first();
  await sessionLink.waitFor({ state: "visible", timeout: 15_000 });
  await sessionLink.click();
  await page.waitForURL(new RegExp(`/session/${sessionId}$`));

  const composer = page.getByPlaceholder("Type your message... (use @ to mention files)");
  await composer.waitFor({ state: "visible" });

  const promptText = `real UI check ${crypto.randomUUID().slice(0, 8)}`;
  await composer.fill(promptText);
  await page.getByRole("button", { name: "Send message" }).click();

  // The user's message renders (optimistic + round-tripped through real
  // opencode). That's the real content the shot must show.
  await waitForText(page.getByTestId("user-message").last(), promptText);
}

function assertNonTrivial(path: string): void {
  const { size } = statSync(path);
  if (size < 10_000) {
    throw new Error(`${path} is only ${size} bytes -- looks blank/broken`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("Booting REAL harness (postgres, web build, hub, real opencode serve, online machine)...");
  const teardown = await globalSetupReal({} as Parameters<typeof globalSetupReal>[0]);

  const state = loadState();
  console.log(`Real machine "${state.machineName}", terminal session ${state.terminalSessionId}`);

  const browser = await chromium.launch();
  const shots: string[] = [];
  try {
    // Desktop light.
    {
      const context = await newContext(browser, { viewport: DESKTOP_VIEWPORT, theme: "light" });
      const page = await context.newPage();
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      const machinesPath = join(OUT_DIR, "machines-real-light.png");
      await captureMachines(page, state.machineName, machinesPath);
      shots.push(machinesPath);
      console.log("Captured machines-real-light.png");

      await openRealSessionAndPrompt(page, state.terminalSessionId, { openMobileDrawer: false });
      const sessionPath = join(OUT_DIR, "session-real-light.png");
      await page.screenshot({ path: sessionPath });
      shots.push(sessionPath);
      console.log("Captured session-real-light.png");

      await context.close();
    }

    // Desktop dark.
    {
      const context = await newContext(browser, { viewport: DESKTOP_VIEWPORT, theme: "dark" });
      const page = await context.newPage();
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      const machinesPath = join(OUT_DIR, "machines-real-dark.png");
      await captureMachines(page, state.machineName, machinesPath);
      shots.push(machinesPath);
      console.log("Captured machines-real-dark.png");

      await openRealSessionAndPrompt(page, state.terminalSessionId, { openMobileDrawer: false });
      const sessionPath = join(OUT_DIR, "session-real-dark.png");
      await page.screenshot({ path: sessionPath });
      shots.push(sessionPath);
      console.log("Captured session-real-dark.png");

      await context.close();
    }

    // Phone dark.
    {
      const context = await newContext(browser, { viewport: PHONE_VIEWPORT, theme: "dark" });
      const page = await context.newPage();
      await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

      await openRealSessionAndPrompt(page, state.terminalSessionId, { openMobileDrawer: true });
      const sessionPhonePath = join(OUT_DIR, "session-real-phone-dark.png");
      await page.screenshot({ path: sessionPhonePath });
      shots.push(sessionPhonePath);
      console.log("Captured session-real-phone-dark.png");

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
    console.log(`Done. Real-opencode screenshots written to ${OUT_DIR}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });

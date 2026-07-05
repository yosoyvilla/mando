// Standalone screenshot capture for the README, run directly (`bun
// e2e/scripts/capture-screenshots.ts` from `e2e/`) -- NOT part of the
// Playwright test suite. It is deliberately kept out of e2e/tests/ so
// `bunx playwright test` never discovers or runs it (that command's
// default testMatch picks up every *.spec.ts under testDir, and there is
// no reliable way to opt a file back in from the CLI once testIgnore
// excludes it -- a separate script sidesteps the question entirely).
//
// Reuses the exact same real-stack boot sequence as the E2E suite by
// importing and calling e2e/global-setup.ts's default export directly:
// Postgres + built web SPA + real hub + stub opencode + one seeded ONLINE
// machine (see that file for the full sequence). This script then drives
// a real Chromium browser (via @playwright/test's `chromium`, not the
// Playwright *test runner*) through the four screens the README needs and
// saves each as a PNG under assets/screenshots/.
//
// Run from e2e/: `bun scripts/capture-screenshots.ts`
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator } from "@playwright/test";
import globalSetup from "../global-setup";
import { login } from "../fixtures/ui-helpers";
import { getDb } from "../../apps/hub/src/db/client";
import { DB_URL, REPO_ROOT } from "../fixtures/machine-lifecycle";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, MACHINE_NAME } from "../harness-config";

const OUT_DIR = join(REPO_ROOT, "assets/screenshots");

// Names shown in the final machines.png -- realistic, not test cruft.
const ONLINE_MACHINE_NAME = "macbook-pro";
const OFFLINE_MACHINE_NAME = "home-server";

// A realistic, opencode-style assistant reply for session.png (injected
// into the stub via MANDO_STUB_REPLY -- see fixtures/stub-opencode.ts). The
// matching prompt is sent below so the captured exchange reads naturally.
const SESSION_PROMPT = "Add a /health endpoint that returns 200 with uptime";
const SESSION_REPLY =
  "Done. I added a GET /health route that returns HTTP 200 with a JSON body " +
  "of { status: \"ok\", uptime } , where uptime comes from process.uptime() " +
  "in seconds. It's mounted before the auth middleware so uptime checks stay " +
  "unauthenticated, and I kept the handler synchronous since there's no I/O. " +
  "You can verify it with: curl -s localhost:3000/health";

async function requestPairingCode(machineName: string): Promise<string> {
  const res = await fetch(`${HUB_BASE_URL}/api/v1/pairing/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineName }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/v1/pairing/request failed with status ${res.status}`);
  }
  const body = (await res.json()) as { code: string };
  return body.code;
}

// Locator.waitFor() only checks visibility, not text content, and
// `expect(...).toContainText()` requires Playwright's test-fixture
// `expect`, which throws when called outside a `test()` block -- this
// script drives Chromium directly, with no test runner involved. Poll the
// rendered text by hand instead.
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

// Rewrites the admin's machine rows so machines.png shows exactly two
// realistic entries -- one online (macbook-pro), one offline with a real
// "last seen" (home-server) -- instead of the accumulated e2e-* test rows.
// Runs against the same DB the hub uses, right before /machines is opened.
async function stageMachinesForScreenshot(): Promise<void> {
  const db = getDb(DB_URL);

  const [admin] = await db<{ id: string }[]>`
    select id from users where email = ${ADMIN_EMAIL}
  `;
  if (!admin) throw new Error(`admin user ${ADMIN_EMAIL} not found`);

  // The harness's live online machine (seeded + connected by globalSetup).
  const [online] = await db<{ id: string }[]>`
    select id from machines
    where name = ${MACHINE_NAME} and revoked_at is null
    order by created_at desc
    limit 1
  `;
  if (!online) throw new Error(`online harness machine ${MACHINE_NAME} not found`);

  // Renaming by id does NOT break the live tunnel -- the registry keys the
  // connection by machine id, not name. So macbook-pro stays Online.
  await db`
    update machines set name = ${ONLINE_MACHINE_NAME}, platform = 'darwin'
    where id = ${online.id}
  `;

  // Remove every other machine for the admin (the e2e-* test cruft) so only
  // the renamed online machine remains before we add the offline one.
  await db`
    delete from machines where user_id = ${admin.id} and id != ${online.id}
  `;

  // Seed one offline machine with a real last-seen (~3h ago). No token /
  // tunnel, so it reads Offline; a non-null last_seen_at makes it show a
  // real time rather than "never".
  await db`
    insert into machines (user_id, name, platform, last_seen_at)
    values (${admin.id}, ${OFFLINE_MACHINE_NAME}, 'linux', now() - interval '3 hours')
  `;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Injected into the in-process stub opencode (started inside globalSetup,
  // same process as this script) so the captured session shows a realistic
  // reply. Read per-request by simulateAssistantTurn, so setting it here --
  // before the prompt is sent -- is sufficient. Unset for every normal test
  // run, where the stub keeps its original placeholder text.
  process.env.MANDO_STUB_REPLY = SESSION_REPLY;

  console.log("Booting harness (postgres, web build, hub, stub opencode, online machine)...");
  const teardown = await globalSetup({} as Parameters<typeof globalSetup>[0]);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL: HUB_BASE_URL,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // 1. Login screen.
    await page.goto("/login");
    await page.getByLabel("Password").waitFor({ state: "visible" });
    await page.screenshot({ path: join(OUT_DIR, "login.png") });
    console.log("Captured login.png");

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // 2. Machines list: exactly two realistic machines -- macbook-pro
    // (Online) and home-server (Offline, with a real last-seen). Rewrite the
    // DB rows first so the accumulated e2e-* test machines don't show.
    await stageMachinesForScreenshot();
    await page.goto("/machines");
    const onlineCard = page.getByRole("listitem").filter({ hasText: ONLINE_MACHINE_NAME });
    const offlineCard = page.getByRole("listitem").filter({ hasText: OFFLINE_MACHINE_NAME });
    await onlineCard.getByText("Online", { exact: true }).waitFor({ state: "visible" });
    await offlineCard.getByText("Offline", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: join(OUT_DIR, "machines.png") });
    console.log("Captured machines.png");

    // 3. Pairing approval screen, with a real pending code from the hub.
    const code = await requestPairingCode(`screenshot-pairing-${crypto.randomUUID().slice(0, 8)}`);
    await page.goto(`/pair?code=${code}`);
    await page.getByLabel("Pairing code").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Approve" }).waitFor({ state: "visible" });
    await page.screenshot({ path: join(OUT_DIR, "pairing.png") });
    console.log("Captured pairing.png");

    // 4. Session view: create a session against the online machine, send a
    // prompt, wait for the stub's streamed reply to fully render.
    await page.goto("/");
    await page.getByTestId("new-session").click();
    await page.waitForURL(/\/session\//);

    await page.getByPlaceholder("Type your message... (use @ to mention files)").fill(SESSION_PROMPT);
    await page.getByRole("button", { name: "Send message" }).click();

    const assistantMessage = page.getByTestId("assistant-message").last();
    // Wait for the tail of the injected realistic reply so the full text has
    // rendered (both stub deltas landed) before capturing.
    await waitForText(assistantMessage, "curl -s localhost:3000/health");
    // Let the transient "Session created" toast dismiss itself -- it
    // otherwise overlaps the Pull/Push/Create PR buttons in the capture.
    await page
      .getByText("Session created")
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => {});
    await page.screenshot({ path: join(OUT_DIR, "session.png") });
    console.log("Captured session.png");

    await browser.close();
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    await teardown();
  }
}

void main()
  .then(() => {
    console.log(`Done. Screenshots written to ${OUT_DIR}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });

// GATED (playwright.real.config.ts, not the default suite): the VISUAL proof
// of the mid-session handoff, driven through the actual browser UI against a
// REAL `opencode serve`. Its sibling real-opencode-handoff.spec.ts proves
// the same continuity at the hub-proxy HTTP layer with the `request`
// fixture; this spec proves it the way a user actually experiences it --
// logging into apps/web, selecting the machine, finding the session they
// started in their terminal in the sidebar, opening it, and sending a prompt
// from the composer.
//
// Scenario (see global-setup-real.ts): before the machine came online, the
// setup created a session the way a real terminal user does, via
// `opencode run` (the "terminal" client), and recorded its id + message
// text in REAL_HANDOFF_STATE_FILE. This test is the "other device": it must
// rediscover THAT exact session in the real UI -- the SPA driving real
// opencode through the tunnel -- and continue it.
//
// No assistant reply is asserted (no model provider is configured in CI).
// Proving the user's prompt (a) renders in the UI and (b) reaches the real
// opencode session (visible via the proxy message history) is sufficient
// proof of continuity, matching the API-level spec's contract.
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { login } from "../fixtures/ui-helpers";
import { loginForCookie } from "../fixtures/hub-api";
import {
  opencodeMessageText,
  REAL_HANDOFF_STATE_FILE,
  type OpencodeMessageEntry,
  type RealHandoffState,
} from "../fixtures/real-opencode";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";

function loadState(): RealHandoffState {
  return JSON.parse(readFileSync(REAL_HANDOFF_STATE_FILE, "utf8")) as RealHandoffState;
}

// The app auto-selects the first ONLINE machine on load (see _app.tsx), which
// in this harness is the real-opencode machine -- so the sidebar combo box
// should already show it. We still assert/enforce the exact machine so the
// test is robust even if another machine were ever left online, which is
// literally the "select the real machine" step of the scenario.
async function ensureMachineSelected(page: Page, machineName: string): Promise<void> {
  const combo = page.getByRole("combobox", { name: "Switch machine" });
  await expect(combo).toBeEnabled();
  await expect
    .poll(async () => combo.inputValue(), {
      message: "machine picker should auto-select an online machine",
      timeout: 15_000,
    })
    .not.toBe("");

  if ((await combo.inputValue()) === machineName) return;

  // Wrong machine auto-selected (e.g. another one left online): pick ours.
  await combo.click();
  await page.getByRole("option", { name: machineName }).click();
  await expect(combo).toHaveValue(machineName);
}

test.describe("real opencode session handoff (browser UI)", () => {
  test("the terminal's session is discoverable and continuable in the UI", async ({ page }) => {
    const state = loadState();

    // 1. Real login flow through the actual LoginView.
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/");

    // 2. Select the real machine (the one tunnelled to real opencode).
    await ensureMachineSelected(page, state.machineName);

    // 3. The session the "terminal" created via `opencode run` -- before
    //    this UI ever connected -- must surface in the sidebar's session
    //    list. We match by the exact session id via its link href, never by
    //    title or list position (opencode lists global sessions).
    const sessionLink = page.locator(`a[href="/session/${state.terminalSessionId}"]`);
    await expect(
      sessionLink,
      "the terminal-created session should appear in the UI session list",
    ).toBeVisible({ timeout: 15_000 });

    // 3a. It's also the newest (only) session in this machine's connect
    //     directory, so the sidebar must pin it with the LIVE badge (see
    //     sidebar-session-list.tsx -- index 0 gets the badge).
    await expect(
      sessionLink.getByText("LIVE"),
      "the terminal-created session, being the newest in its directory, should carry the LIVE badge",
    ).toBeVisible();

    // 4. Open it; the message view must load without error AND render the
    //    terminal's own message text -- this is the exact production bug
    //    this suite guards against (session visible, messages empty).
    await sessionLink.click();
    await expect(page).toHaveURL(new RegExp(`/session/${state.terminalSessionId}$`));
    await expect(
      page.getByText(/^Error:/),
      "the session message view should load without an error banner",
    ).toHaveCount(0);
    await expect(
      page.getByTestId("user-message").filter({ hasText: state.terminalMessageText }),
      "the terminal's own message text should render in the reopened session",
    ).toBeVisible();

    const composer = page.getByPlaceholder("Type your message... (use @ to mention files)");
    await expect(composer).toBeVisible();

    // 5. Type and send a prompt from the composer.
    const promptText = `browser handoff ${crypto.randomUUID().slice(0, 8)}`;
    await composer.fill(promptText);
    await page.getByRole("button", { name: "Send message" }).click();

    // 5a. The user's message renders in the UI (optimistic + round-tripped).
    await expect(page.getByTestId("user-message").last()).toContainText(promptText);

    // 5b. And it actually REACHED the real opencode session -- confirmed by
    //     the same hub proxy the UI uses, showing the user message recorded
    //     in that session's history on the real server. (No assistant reply
    //     required: no provider is configured in CI.)
    const cookie = await loginForCookie(state.hubBaseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect
      .poll(
        async () => {
          const res = await fetch(
            `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session/${state.terminalSessionId}/message`,
            { headers: { cookie } },
          );
          if (!res.ok) return false;
          const body = (await res.json()) as OpencodeMessageEntry[];
          return body.some((entry) => opencodeMessageText(entry) === promptText);
        },
        {
          message: "the prompt sent from the browser should reach the real opencode session",
          timeout: 10_000,
        },
      )
      .toBe(true);
  });
});

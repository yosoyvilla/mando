import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";
import { login } from "../fixtures/ui-helpers";

// The core /rc-parity flow: select the (already online) harness machine,
// open a session, send a prompt, and watch the stub opencode's simulated
// assistant turn (fixtures/stub-opencode.ts's `simulateAssistantTurn`)
// render incrementally through the real SSE pipeline
// (apps/web/src/hooks/use-opencode-events.ts -> use-session-messages.ts).
test.describe("session drive", () => {
  test("sending a prompt streams the assistant reply incrementally", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    // AppLayout (routes/_app.tsx) auto-selects the only online machine, so
    // there's nothing to pick here -- go straight to creating a session.
    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\//);

    const promptText = `hello from playwright ${crypto.randomUUID().slice(0, 8)}`;
    await page.getByPlaceholder("Type your message... (use @ to mention files)").fill(promptText);
    await page.getByRole("button", { name: "Send message" }).click();

    // The user's own message round-trips back through
    // `session.next.prompted` and renders via the same pipeline.
    await expect(page.getByTestId("user-message").last()).toContainText(promptText);

    // First delta only -- asserts the partial chunk is visible before the
    // full reply lands (content-based: this exact substring is only ever
    // sent as the *first* of two separate text.delta events, 150ms apart
    // -- see stub-opencode.ts). Not a timing assertion: whenever this
    // check runs, if it's already true the full text will contain it too,
    // so the meaningful case is racing it against the second half below.
    const assistantMessage = page.getByTestId("assistant-message").last();
    await expect(assistantMessage).toContainText("stub reply incoming");

    // Full reply, once both deltas have arrived and text.ended settled it.
    await expect(assistantMessage).toContainText(`stub reply to: ${promptText}`);
  });
});

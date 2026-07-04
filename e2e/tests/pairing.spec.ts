import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL } from "../harness-config";
import { login } from "../fixtures/ui-helpers";

// Drives apps/web/src/components/pairing-view.tsx (code entry + deep link)
// against the real hub. The pairing *code* itself comes from the hub's own
// POST /api/v1/pairing/request -- the same call the real `mando` agent CLI
// makes before it has any credentials (see apps/hub/src/pairing/routes.ts,
// "No auth: the agent calls this before it has any credentials at all").
// Using the API for that half (rather than also driving an agent CLI) is
// exactly what the task brief calls out as acceptable: only the browser
// side of the flow -- the approval -- is what this suite exists to verify.
async function requestPairingCode(
  request: import("@playwright/test").APIRequestContext,
  machineName: string,
): Promise<string> {
  const res = await request.post(`${HUB_BASE_URL}/api/v1/pairing/request`, {
    data: { machineName },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { code: string };
  return body.code;
}

test.describe("pairing", () => {
  test("approving a pairing code via the ?code= deep link links the machine", async ({
    page,
    request,
  }) => {
    const machineName = `e2e-pairing-deeplink-${crypto.randomUUID().slice(0, 8)}`;
    const code = await requestPairingCode(request, machineName);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/pair?code=${code}`);

    await expect(page.getByLabel("Pairing code")).toHaveValue(code);
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByRole("status")).toContainText("paired successfully");

    await page.goto("/machines");
    await expect(
      page.getByRole("listitem").filter({ hasText: machineName }),
    ).toBeVisible();
  });

  test("entering a pairing code by hand also links the machine", async ({
    page,
    request,
  }) => {
    const machineName = `e2e-pairing-manual-${crypto.randomUUID().slice(0, 8)}`;
    const code = await requestPairingCode(request, machineName);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/pair");

    await expect(page.getByLabel("Pairing code")).toHaveValue("");
    await page.getByLabel("Pairing code").fill(code);
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByRole("status")).toContainText("paired successfully");

    await page.goto("/machines");
    await expect(
      page.getByRole("listitem").filter({ hasText: machineName }),
    ).toBeVisible();
  });

  test("an unknown code shows an error instead of succeeding", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto("/pair");

    await page.getByLabel("Pairing code").fill("NOTAREAL-CODE1");
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
  });
});

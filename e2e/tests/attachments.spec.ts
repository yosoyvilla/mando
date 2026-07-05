import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, MACHINE_NAME } from "../harness-config";
import { login } from "../fixtures/ui-helpers";

// Minimal in-memory fixtures -- Playwright's setInputFiles accepts
// {name, mimeType, buffer} directly, so there is no reason to check binary
// files into the repo for a 67-byte PNG and a handful of PDF-shaped bytes.
// The PDF's content is never parsed by anything in this path (the composer
// trusts the File's declared MIME type, and both the stub and real opencode
// store the data URL verbatim), so a placeholder body is enough.
const PNG_FIXTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PDF_FIXTURE = Buffer.from("%PDF-1.4 fake pdf body for e2e coverage");

interface StubMessageEntry {
  info: { id: string; role: string };
  parts: Array<{
    id: string;
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }>;
}

async function getMachineId(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.get(`${HUB_BASE_URL}/api/v1/machines`);
  const body = (await res.json()) as { machines: Array<{ id: string; name: string }> };
  const machine = body.machines.find((m) => m.name === MACHINE_NAME);
  if (!machine) throw new Error(`harness machine "${MACHINE_NAME}" not found`);
  return machine.id;
}

// End-to-end coverage of Task 1+2's composer attach/render pipeline against
// the stub, plus the caps-math boundary the plan (docs/superpowers/plans/
// 2026-07-05-attachments.md) requires be locked empirically over the real
// hub->agent tunnel frame, not just unit-asserted against the byte math.
test.describe("attachments", () => {
  test("composer attaches an image and a PDF, sends them, and they render in history", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\/([^/]+)/);
    const sessionId = new URL(page.url()).pathname.split("/").pop();
    if (!sessionId) throw new Error("could not read session id from URL");

    // The composer's file input is `hidden` (routes/_app/session/$id.tsx),
    // not visually hidden via CSS -- Playwright's setInputFiles works
    // against it directly without needing to reveal it first.
    await page
      .locator('input[type="file"]')
      .setInputFiles([
        { name: "pixel.png", mimeType: "image/png", buffer: PNG_FIXTURE },
        { name: "note.pdf", mimeType: "application/pdf", buffer: PDF_FIXTURE },
      ]);

    await expect(page.getByTestId("composer-attachment-chip")).toHaveCount(2);

    const promptText = `attach test ${crypto.randomUUID().slice(0, 8)}`;
    await page
      .getByPlaceholder("Type your message... (use @ to mention files)")
      .fill(promptText);
    await page.getByRole("button", { name: "Send message" }).click();

    // Chips clear after send -- ComposerAttachments renders nothing once
    // the attachment queue is empty.
    await expect(page.getByTestId("composer-attachments")).toHaveCount(0);

    // History renders the image inline and the PDF as a labeled chip (Task
    // 2's render path -- apps/web/src/components/attached-files.tsx).
    const renderedImage = page.getByTestId("attached-file-image").first();
    await expect(renderedImage).toBeVisible();
    await expect(renderedImage.locator("img")).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await expect(page.getByTestId("attached-file-pdf").first()).toBeVisible();
    await expect(page.getByTestId("attached-file-pdf").first()).toContainText(
      "note.pdf",
    );

    // The stub must have received and persisted the exact wire shape the
    // composer sends: files ahead of the text part (see
    // apps/web/src/routes/_app/session/$id.tsx's `sendMessage` -- "Files are
    // sent ahead of the text part"), each carrying the right mime and a
    // data: URL of the right type.
    const machineId = await getMachineId(page.request);
    const messagesRes = await page.request.get(
      `${HUB_BASE_URL}/api/v1/machines/${machineId}/opencode/session/${sessionId}/message`,
    );
    expect(messagesRes.ok()).toBeTruthy();
    const entries = (await messagesRes.json()) as StubMessageEntry[];
    const userEntry = entries.find(
      (entry) => entry.info.role === "user" && entry.parts.some((part) => part.type === "file"),
    );
    expect(userEntry, "the sent message should be recorded with its file parts").toBeTruthy();

    expect(userEntry!.parts.map((part) => part.type)).toEqual(["file", "file", "text"]);
    const [imagePart, pdfPart, textPart] = userEntry!.parts;
    expect(imagePart.mime).toBe("image/png");
    expect(imagePart.filename).toBe("pixel.png");
    expect(imagePart.url).toMatch(/^data:image\/png;base64,/);
    expect(pdfPart.mime).toBe("application/pdf");
    expect(pdfPart.filename).toBe("note.pdf");
    expect(pdfPart.url).toMatch(/^data:application\/pdf;base64,/);
    expect(textPart.text).toBe(promptText);
  });

  // Locks the plan's caps math empirically: a ~7MB raw attachment (under
  // the product's 8MB-total cap, see apps/web/src/lib/attachments.ts) must
  // cross the REAL hub->agent WS tunnel frame -- which double-base64-encodes
  // the body (browser data-URL, then the proxy's http_request frame
  // re-encodes the whole request), landing well under Bun's 16MB default WS
  // frame limit -- and read back byte-identical. Driven directly through the
  // hub proxy (not the composer UI): the thing under test is the tunnel's
  // byte budget, not the browser's file-picker plumbing.
  test("a ~7MB attachment crosses the hub proxy tunnel intact", async ({ page }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    const machineId = await getMachineId(page.request);

    const createRes = await page.request.post(
      `${HUB_BASE_URL}/api/v1/machines/${machineId}/opencode/session`,
      { headers: { "content-type": "application/json" }, data: {} },
    );
    expect(createRes.ok(), `POST .../opencode/session should be 2xx, got ${createRes.status()}`).toBeTruthy();
    const session = (await createRes.json()) as { id: string };

    const rawBytes = 7 * 1024 * 1024;
    const payload = Buffer.alloc(rawBytes, 0x41); // repeated 'A'
    const dataUrl = `data:application/pdf;base64,${payload.toString("base64")}`;

    const messageRes = await page.request.post(
      `${HUB_BASE_URL}/api/v1/machines/${machineId}/opencode/session/${session.id}/message`,
      {
        headers: { "content-type": "application/json" },
        data: {
          parts: [
            { type: "file", mime: "application/pdf", filename: "big.pdf", url: dataUrl },
          ],
        },
      },
    );
    expect(
      messageRes.ok(),
      `POST .../message should accept the ~7MB attachment, got ${messageRes.status()}`,
    ).toBeTruthy();

    const messagesRes = await page.request.get(
      `${HUB_BASE_URL}/api/v1/machines/${machineId}/opencode/session/${session.id}/message`,
    );
    expect(messagesRes.ok()).toBeTruthy();
    const entries = (await messagesRes.json()) as StubMessageEntry[];
    const userEntry = entries.find((entry) => entry.info.role === "user");
    expect(userEntry, "the ~7MB message should be recorded").toBeTruthy();
    const filePart = userEntry!.parts.find((part) => part.type === "file");
    expect(filePart, "the recorded message should carry the file part").toBeTruthy();
    expect(filePart!.mime).toBe("application/pdf");
    expect(filePart!.filename).toBe("big.pdf");
    // Byte-identical round trip through the tunnel, not just a length check.
    expect(filePart!.url).toBe(dataUrl);
  });
});

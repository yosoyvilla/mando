import { test, expect } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "../harness-config";
import { login } from "../fixtures/ui-helpers";
import { enqueueStubPermission } from "../fixtures/stub-control";

// Proves the full remote-approval round trip Task 1 exists for: a
// permission request surfaces in the session view via the real SSE
// pipeline (permission.asked -> use-opencode-events.ts ->
// usePermissions()), clicking Approve replies through the connect
// directory (apps/web/src/hooks/use-opencode.ts's useReplyPermission), and
// the request disappears from the view once the stub accepts the reply.
// If the reply were ever sent without `?directory=`, the DIRECTORY-SCOPED
// stub (fixtures/stub-opencode.ts) would 404 it and the card would stay
// stuck showing an error instead of clearing -- so the clearing assertion
// below is itself proof the directory made it onto the wire, and the
// explicit URL assertion pins that down directly.
test.describe("permission approval", () => {
  test("a permission request appears, Approve replies with the connect directory, and the request clears", async ({
    page,
  }) => {
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    await page.getByTestId("new-session").click();
    await expect(page).toHaveURL(/\/session\/(.+)/);
    const sessionId = new URL(page.url()).pathname.split("/session/")[1];
    expect(sessionId).toBeTruthy();

    await enqueueStubPermission({
      sessionID: sessionId,
      permission: "bash",
      patterns: ["rm -rf *"],
    });

    const permissionCard = page.getByText("Permission required");
    await expect(permissionCard).toBeVisible();
    await expect(page.getByText("rm -rf *")).toBeVisible();

    const replyRequest = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        /\/opencode\/permission\/[^/]+\/reply\?directory=/.test(req.url()),
    );

    await page.getByRole("button", { name: "Allow once" }).click();

    const request = await replyRequest;
    expect(request.url()).toMatch(/\/opencode\/permission\/[^/]+\/reply\?directory=/);
    expect(JSON.parse(request.postData() ?? "{}")).toEqual({ reply: "once" });

    await expect(permissionCard).not.toBeVisible();
  });
});

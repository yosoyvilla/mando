// Test-only control channel for the stub opencode server (see
// stub-opencode.ts's `/_stub/permission` handler). Spec files run in the
// worker process Playwright forks after globalSetup.ts finishes -- see
// harness-config.ts's `STUB_PORT_ENV` doc comment for why that env var is
// how a spec learns the stub's ephemeral port, rather than importing
// global-setup.ts's own `stub` reference directly. Talks straight to the
// stub over plain `fetch`, bypassing the hub's per-machine proxy entirely:
// this is the harness reaching into its own fixture, not something the web
// app or a real opencode client would ever do.
import { STUB_PORT_ENV } from "../harness-config";

function stubBaseUrl(): string {
  const port = process.env[STUB_PORT_ENV];
  if (!port) {
    throw new Error(
      `${STUB_PORT_ENV} is not set -- enqueueStubPermission must run after global-setup.ts has started the stub`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

export interface StubPermissionRequest {
  sessionID: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID: string; callID: string };
}

export interface StubPermission extends StubPermissionRequest {
  id: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
}

// Pushes a permission request into the stub for `sessionID`, broadcasting a
// real-shaped `permission.asked` SSE frame to every connected browser --
// the same signal a real opencode server would emit for an actual
// tool-permission gate. Returns the created request so a spec can assert
// on its id if needed.
export async function enqueueStubPermission(
  request: StubPermissionRequest,
): Promise<StubPermission> {
  const res = await fetch(`${stubBaseUrl()}/_stub/permission`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`enqueueStubPermission failed with status ${res.status}`);
  }
  return (await res.json()) as StubPermission;
}

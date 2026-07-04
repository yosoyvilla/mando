// Small Node-safe helpers for talking to the hub's plain JSON API directly
// (no browser involved) -- used by global-setup.ts to bootstrap/verify the
// harness machine, and by spec files' `test.beforeAll`/helpers that need a
// second online machine or a second user without driving the UI for setup
// that isn't the thing under test (see task-8.2-report.md). Playwright's
// runner executes spec files under Node (same "Node vs Bun" note as
// global-setup.ts), so plain `fetch` here is safe.
const SESSION_COOKIE_NAME = "mando_sess";

function parseSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? `${SESSION_COOKIE_NAME}=${match[1]}` : null;
}

// Logs in via POST /api/v1/auth/login and returns a `Cookie:` header value
// good for authenticated follow-up fetches. Not used to drive the browser
// (specs log in through the real LoginView for that) -- only for Node-side
// setup/polling that happens outside of what a test is actually asserting.
export async function loginForCookie(hubBaseUrl: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${hubBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email} with status ${res.status}`);
  const cookie = parseSessionCookie(res.headers.get("set-cookie"));
  if (!cookie) throw new Error(`login succeeded for ${email} but response carried no session cookie`);
  return cookie;
}

export async function isMachineOnline(hubBaseUrl: string, cookie: string, machineName: string): Promise<boolean> {
  const res = await fetch(`${hubBaseUrl}/api/v1/machines`, { headers: { cookie } });
  if (!res.ok) return false;
  const body = (await res.json()) as { machines: Array<{ name: string; online: boolean }> };
  return body.machines.some((machine) => machine.name === machineName && machine.online);
}

// Invites (creates) a second user via POST /api/v1/auth/invite, the only
// hub endpoint that can create a non-bootstrap user -- POST
// /api/v1/auth/bootstrap refuses once any user exists (see
// apps/hub/src/users/routes.ts), which is already true by the time any
// spec runs (global-setup.ts's admin bootstrap). Requires an authenticated
// admin cookie. Returns the invitee's random temp password so a spec can
// log in as them through the real LoginView.
export async function inviteUser(
  hubBaseUrl: string,
  adminCookie: string,
  email: string,
): Promise<{ userId: string; tempPassword: string }> {
  const res = await fetch(`${hubBaseUrl}/api/v1/auth/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`invite failed for ${email} with status ${res.status}`);
  const body = (await res.json()) as { user: { id: string; email: string }; tempPassword: string };
  return { userId: body.user.id, tempPassword: body.tempPassword };
}

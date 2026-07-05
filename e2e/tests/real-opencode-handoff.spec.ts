// GATED (playwright.real.config.ts, not the default suite): the definitive
// proof that Mando's hub -> agent -> opencode proxy path works against a
// REAL `opencode serve`, not the stub we wrote ourselves. The default
// stub-based e2e suite, however faithful, was authored by us and could
// share the web UI's assumptions about opencode's API; this test removes
// that shared blind spot by driving the real binary end to end.
//
// Scenario (the "mid-session handoff"): a user starts an opencode session
// in their terminal (via `opencode run`, not the server API -- see
// global-setup-real.ts), runs `/mando` to connect the machine, then opens
// Mando on another device and continues THAT SAME session. This spec is
// the "other device", talking only to the hub's per-machine proxy
// (`/api/v1/machines/:id/opencode/*`) over the UNPREFIXED opencode family
// -- the same paths apps/web calls (see apps/web/src/lib/opencode-fetch.ts).
//
// Why the `request` fixture and not the browser: the thing under test is
// the hub->agent->real-opencode HTTP path over the real unprefixed routes,
// not pixels. Driving it through Playwright's request client keeps the
// proof focused on exactly that path (and gives a clean trace of each
// call).
//
// No assistant reply is asserted: a full model turn needs a provider that
// won't be configured in CI. Proving the terminal's session (a) is visible
// through the proxy and (b) its USER MESSAGE CONTENT round-trips through
// the proxy is the exact production bug this suite guards against --
// "session visible, messages empty" -- so that is what's asserted, plus
// that a fresh prompt sent through the proxy also reaches the real session.
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext } from "@playwright/test";
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

async function fetchMessages(
  request: APIRequestContext,
  state: RealHandoffState,
  cookie: string,
): Promise<OpencodeMessageEntry[]> {
  const res = await request.get(
    `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session/${state.terminalSessionId}/message`,
    { headers: { cookie } },
  );
  expect(res.ok(), `GET .../message should be 2xx, got ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as OpencodeMessageEntry[];
  expect(Array.isArray(body), "message history payload should be a bare array").toBeTruthy();
  return body;
}

test.describe("real opencode session handoff", () => {
  let cookie: string;
  let state: RealHandoffState;

  test.beforeAll(async () => {
    state = loadState();
    // Authenticated hub user cookie -- the proxy requires a real session
    // (requireUser + requireMachineOwnership). This is setup, not the thing
    // under test, so it uses the Node-side login helper rather than the UI.
    cookie = await loginForCookie(state.hubBaseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  // Assertion 1: the session the "terminal" created via `opencode run` is
  // visible in the machine's DIRECTORY-SCOPED session list obtained THROUGH
  // the hub proxy -- exactly how the web UI's useSessions() scopes it (see
  // apps/web/src/hooks/use-opencode.ts's `sessionsPath`).
  test("the terminal's session is discoverable via the hub proxy", async ({ request }) => {
    const res = await request.get(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session?directory=${encodeURIComponent(state.directory)}`,
      { headers: { cookie } },
    );
    expect(res.ok(), `GET .../opencode/session should be 2xx, got ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((s) => s.id);
    expect(ids, "proxied session list should include the terminal-created session").toContain(
      state.terminalSessionId,
    );
  });

  // Assertion 2: that session's USER MESSAGE CONTENT round-trips via the
  // proxy -- the exact production bug this suite guards against (a session
  // that shows up in the list but whose messages come back empty).
  test("the terminal's user message content is loadable via the hub proxy", async ({ request }) => {
    const entries = await fetchMessages(request, state, cookie);
    const userEntry = entries.find((entry) => entry.info.role === "user");
    expect(userEntry, "the terminal-created session should have a user message").toBeTruthy();
    // `toContain`, not `toBe`: `opencode run <message>` (verified against a
    // live opencode 1.17.13) wraps a single multi-word argv message in
    // literal JSON quotes when it persists the user message -- a CLI
    // argument-marshaling quirk, not something this suite is verifying.
    // What matters here is the actual production bug this suite guards
    // against: that the message content round-trips through the proxy at
    // all (session visible, messages NOT empty).
    expect(opencodeMessageText(userEntry!)).toContain(state.terminalMessageText);
  });

  // Assertion 3: a prompt POSTed through the proxy REACHES the real opencode
  // session -- accepted (2xx) AND recorded as a new user message in that
  // session's history. We do NOT require an assistant reply (no provider in
  // CI); real opencode records the user message and returns 2xx regardless.
  test("a prompt sent via the hub proxy reaches the real opencode session", async ({ request }) => {
    const promptText = `handoff continuity ${crypto.randomUUID().slice(0, 8)}`;

    const before = await fetchMessages(request, state, cookie);
    expect(before.some((entry) => opencodeMessageText(entry) === promptText), "unique prompt must not pre-exist").toBeFalsy();

    const res = await request.post(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session/${state.terminalSessionId}/message`,
      {
        headers: { cookie, "content-type": "application/json" },
        data: { parts: [{ type: "text", text: promptText }] },
      },
    );
    expect(res.ok(), `POST .../message should be accepted by real opencode (2xx), got ${res.status()}`).toBeTruthy();

    // The prompt reaching the real session is proven by the user message
    // appearing in that session's history (polled: recording is fast but
    // not synchronous with the accept response).
    await expect
      .poll(
        async () => (await fetchMessages(request, state, cookie)).some((entry) => opencodeMessageText(entry) === promptText),
        {
          message: "the prompted user message should appear in the real opencode session",
          timeout: 10_000,
        },
      )
      .toBe(true);
  });
});

// Broader proof that the core opencode surface the UI depends on works
// against the REAL server (not just the stub), all exercised through the
// same hub proxy the browser uses. These are the read/create paths behind
// the sidebar's session list, the agent/model pickers, and the live event
// stream -- if any of them behaved differently on real opencode than on the
// stub, the UI would silently break in production while the stub suite
// stayed green.
test.describe("real opencode core surface via the hub proxy", () => {
  let cookie: string;
  let state: RealHandoffState;

  test.beforeAll(async () => {
    state = loadState();
    cookie = await loginForCookie(state.hubBaseUrl, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  // Creating a session through the proxy (POST /session, body `{directory}`)
  // is the exact path the sidebar's "New Session" button drives (see
  // use-opencode.ts's `useCreateSession`); the created id must then be
  // visible in the proxied, directory-scoped session list.
  test("a session created via the proxy appears in the proxied session list", async ({ request }) => {
    const createRes = await request.post(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session`,
      { headers: { cookie, "content-type": "application/json" }, data: { directory: state.directory } },
    );
    expect(createRes.ok(), `POST .../opencode/session should be 2xx, got ${createRes.status()}`).toBeTruthy();
    const created = (await createRes.json()) as { id: string };
    expect(created.id, "create session response should carry a bare id").toBeTruthy();

    const listRes = await request.get(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/session?directory=${encodeURIComponent(state.directory)}`,
      { headers: { cookie } },
    );
    expect(listRes.ok(), `GET .../opencode/session should be 2xx, got ${listRes.status()}`).toBeTruthy();
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.map((s) => s.id), "newly created session should appear in the list").toContain(created.id);
  });

  // The agent picker (agent-select.tsx) reads the legacy flat `/agent`
  // catalog -- real opencode ships built-in agents, so it must be non-empty.
  test("GET /agent returns a non-empty agent list", async ({ request }) => {
    const res = await request.get(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/agent`,
      { headers: { cookie } },
    );
    expect(res.ok(), `GET .../agent should be 2xx, got ${res.status()}`).toBeTruthy();
    const agents = (await res.json()) as Array<{ name: string }>;
    expect(Array.isArray(agents), "agent catalog should be an array").toBeTruthy();
    expect(agents.length, "real opencode should ship built-in agents").toBeGreaterThan(0);
  });

  // The model picker (model-select.tsx via useProviders) reads the legacy
  // `/config/providers` path (there is no /api/config/providers on real
  // opencode 1.17.13 -- see use-opencode.ts). Assert it returns the
  // `{ providers: [...] }` shape the UI expects.
  test("GET /config/providers returns a providers catalog", async ({ request }) => {
    const res = await request.get(
      `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/config/providers`,
      { headers: { cookie } },
    );
    expect(res.ok(), `GET .../config/providers should be 2xx, got ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as { providers: unknown[] };
    expect(Array.isArray(body.providers), "providers payload should carry a providers array").toBeTruthy();
  });

  // The live SSE stream (use-opencode-events.ts opens `/event`) is what
  // keeps the session list and message view fresh. Prove a frame actually
  // flows through the proxy by reading the stream until opencode's opening
  // `server.connected` event arrives, then aborting.
  test("GET /event streams the opening server.connected frame via the proxy", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(
        `${state.hubBaseUrl}/api/v1/machines/${state.machineId}/opencode/event`,
        { headers: { cookie, accept: "text/event-stream" }, signal: controller.signal },
      );
      expect(res.ok, `GET .../event should be 2xx, got ${res.status}`).toBeTruthy();
      expect(res.body, "event stream should expose a readable body").toBeTruthy();

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawConnected = false;
      // Read chunks until the first SSE frame carrying server.connected
      // lands (it is the first event real opencode emits on connect).
      while (!sawConnected) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("server.connected")) sawConnected = true;
      }
      await reader.cancel().catch(() => {});
      expect(sawConnected, "the proxied event stream should deliver server.connected").toBe(true);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});

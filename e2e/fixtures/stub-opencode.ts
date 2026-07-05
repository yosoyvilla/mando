// A minimal, in-process fake of a local `opencode` server -- the thing the
// real `mando` agent daemon forwards HTTP requests to on 127.0.0.1. It only
// implements the handful of REAL opencode API paths the web UI actually
// calls through the hub's per-machine proxy (`HubClient.opencode(id).fetch
// /events`, see apps/web/src/lib/opencode-fetch.ts) plus `GET /doc`, which
// is not a proxy path at all -- it's what the agent's own `checkHealth()`
// (packages/agent/src/opencode.ts) polls directly against this port to
// decide the local opencode server is alive. Without a `/doc` response the
// daemon's health-check loop (packages/agent/src/daemon.ts) would mark the
// machine unreachable and tear down the tunnel ~45s into any test run.
//
// Every path/method/body/response shape here was verified against a real
// `opencode serve` (v1.17.13) via its `/doc` OpenAPI spec and live curls.
// Real opencode has two parallel API surfaces: a newer `/api/*` one
// (enveloped `{ data: ... }` responses, server-created sessions only) and
// the UNPREFIXED legacy-flat one this stub now emulates exclusively -- it's
// the one that also serves sessions created by a plain `opencode` TUI/run
// (the whole point of Mando: continuing a session you started in a
// terminal). apps/web/src switched to the unprefixed family entirely (see
// apps/web/src/lib/opencode-fetch.ts's module comment); this stub mirrors
// that, and deliberately 404s any `/api/*` session/event path below so a
// regression back to the old family fails loudly instead of silently
// working against a fake that's more permissive than the real server.
//
// Built on node:http, not Bun.serve: this module is imported directly by
// global-setup.ts, which Playwright's test runner loads and executes under
// a real Node.js process even when the whole suite is launched via
// `bunx playwright test` (see global-setup.ts's "Node vs Bun" note -- Bun is
// simply not defined in that context). node:http covers everything this
// fake needs (plain JSON responses, one long-lived SSE stream), so there's
// no reason to fight the runtime here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface StubSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: { created: number; updated: number };
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
}

// Loosely typed on purpose -- these mirror real opencode's `{info, parts}`
// message shape (confirmed via live curl against 1.17.13's `GET
// /session/:id/message`), but nothing here needs to import the SDK's
// exact types since the fetcher on the web side (`normalizeFetchedMessages`
// in use-session-messages.ts) already treats the wire shape as loosely
// typed `unknown` and narrows defensively.
type StubMessageInfo = Record<string, unknown>;
type StubPart = Record<string, unknown>;
interface StubMessageEntry {
  info: StubMessageInfo;
  parts: StubPart[];
}

export interface StubOpencode {
  port: number;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendText(
  res: ServerResponse,
  body: string,
  contentType: string,
  status = 200,
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function stubId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Sessions created without an explicit `directory` (real opencode's `POST
// /session` also defaults to the server's own project when the caller omits
// it) land here -- distinct enough from any real connect directory that a
// directory-scoped `GET /session?directory=...` never accidentally matches
// it by coincidence.
const DEFAULT_DIRECTORY = "/tmp/mando-e2e-stub-default";

export async function startStubOpencode(): Promise<StubOpencode> {
  const sessions = new Map<string, StubSession>();
  const messages = new Map<string, StubMessageEntry[]>();
  const activeSessions = new Set<string>();
  const sseClients = new Set<ServerResponse>();

  // Real `/event` frames are `data: {"id":"evt_...","type":"...",
  // "properties":{...}}` -- the payload field is `properties`, confirmed by
  // reading raw SSE bytes off a live opencode 1.17.13 server (the installed
  // `@opencode-ai/sdk`'s `Event` union agrees). This replaces the `/api/*`
  // family's `data` field, which the SDK's own /api types use instead.
  function broadcast(event: { type: string; properties: Record<string, unknown> }): void {
    const frame = { id: stubId("evt"), ...event };
    const chunk = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of sseClients) {
      res.write(chunk);
    }
  }

  function pushMessage(sessionId: string, entry: StubMessageEntry): void {
    const list = messages.get(sessionId) ?? [];
    list.push(entry);
    messages.set(sessionId, list);
  }

  function touchSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.time.updated = Date.now();
    broadcast({
      type: "session.updated",
      properties: { sessionID: sessionId, info: session },
    });
  }

  // Simulates a short assistant turn (step -> streamed text -> step end ->
  // idle) so a Playwright spec awaiting streamed output has something real
  // to observe, without needing an actual model. The reply is split into
  // two `session.next.text.delta` events separated by a short delay, rather
  // than one delta carrying the whole reply -- session-drive.spec.ts needs
  // to assert that a *partial* chunk renders before the full text does
  // (content-based, not a wall-clock assertion: the test waits for the
  // first chunk's exact substring, then for the full reply, and never
  // asserts on timing itself). The delay is just what makes that first,
  // partial DOM state observable instead of collapsing into the same 16ms
  // client-side event batch as everything else (see
  // apps/web/src/hooks/use-opencode-events.ts's `enqueue`/`flush`).
  //
  // Event payloads deliberately carry only the fields the real SDK types
  // declare (confirmed against opencode 1.17.13's `/doc`) -- e.g. no
  // `assistantMessageID`/`textID` on step/text events. The web side never
  // needs them either: it tracks "the active assistant message" by index
  // (last assistant message without `time.completed`), not by id -- see
  // use-opencode-events.ts's `activeAssistantIndex`/`latestTextIndex`.
  //
  // Once the turn ends, the finished assistant message is also recorded in
  // `messages` in the real `{info, parts}` shape (`GET
  // /session/:id/message`). Without this, `session.idle`'s own
  // `revalidateMessagesNow` (a real behavior of the web app, not a test
  // artifact) would GET that endpoint a moment later and get back only the
  // user message, wiping the assistant text the SSE deltas had just
  // rendered.
  function simulateAssistantTurn(sessionId: string, promptText: string): void {
    const now = Date.now();
    const assistantMessageId = stubId("msg");
    const model = { id: "stub-model", providerID: "stub", variant: "default" };

    // Reply text is overridable via MANDO_STUB_REPLY so the README
    // screenshot capture (e2e/scripts/capture-screenshots.ts) can show a
    // realistic assistant answer instead of the placeholder-looking default.
    // When the env var is unset (every normal `bunx playwright test` run),
    // the two chunks below are byte-identical to what the suite has always
    // produced -- session-drive.spec.ts asserts both "stub reply incoming"
    // (the first delta) and `stub reply to: <prompt>` (the full text), so
    // the default MUST NOT change. A custom reply is split near its midpoint
    // (on a space) into the same two-delta shape, preserving the
    // partial-then-full streaming the pipeline exercises.
    const envReply = process.env.MANDO_STUB_REPLY;
    let firstChunk: string;
    let secondChunk: string;
    if (envReply && envReply.length > 0) {
      const mid = Math.floor(envReply.length / 2);
      const spaceIdx = envReply.lastIndexOf(" ", mid);
      const split = spaceIdx > 0 ? spaceIdx + 1 : mid;
      firstChunk = envReply.slice(0, split);
      secondChunk = envReply.slice(split);
    } else {
      firstChunk = "stub reply incoming -- ";
      secondChunk = `stub reply to: ${promptText}`;
    }
    const replyText = `${firstChunk}${secondChunk}`;

    activeSessions.add(sessionId);

    broadcast({
      type: "session.next.step.started",
      properties: { timestamp: now, sessionID: sessionId, agent: "build", model },
    });
    broadcast({
      type: "session.next.text.started",
      properties: { timestamp: now, sessionID: sessionId },
    });
    broadcast({
      type: "session.next.text.delta",
      properties: { timestamp: now, sessionID: sessionId, delta: firstChunk },
    });

    setTimeout(() => {
      const later = Date.now();
      broadcast({
        type: "session.next.text.delta",
        properties: { timestamp: later, sessionID: sessionId, delta: secondChunk },
      });
      broadcast({
        type: "session.next.text.ended",
        properties: { timestamp: later, sessionID: sessionId, text: replyText },
      });
      broadcast({
        type: "session.next.step.ended",
        properties: {
          timestamp: later,
          sessionID: sessionId,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      pushMessage(sessionId, {
        info: {
          id: assistantMessageId,
          sessionID: sessionId,
          role: "assistant",
          time: { created: now, completed: later },
          parentID: "",
          modelID: model.id,
          providerID: model.providerID,
          mode: model.variant,
          agent: "build",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        },
        parts: [
          {
            id: stubId("prt"),
            sessionID: sessionId,
            messageID: assistantMessageId,
            type: "text",
            text: replyText,
          },
        ],
      });
      activeSessions.delete(sessionId);
      broadcast({ type: "session.idle", properties: { sessionID: sessionId } });
      touchSession(sessionId);
    }, 150);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://stub-opencode.local");
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Local health probe -- see module comment. Any response proves a real
    // HTTP server is listening; status/body don't matter to the caller.
    if (method === "GET" && path === "/doc") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    // `GET /session` (confirmed against a live opencode 1.17.13) -> bare
    // array of `Session`. `?directory=<abs path>` scopes the list to that
    // project -- see apps/web/src/hooks/use-opencode.ts's `sessionsPath`;
    // omitting it would serve the *server's own* cwd project on real
    // opencode, but nothing here needs that distinction since every stub
    // session already carries an explicit `directory`.
    if (method === "GET" && path === "/session") {
      const directory = url.searchParams.get("directory");
      const list = [...sessions.values()].filter(
        (session) => !directory || session.directory === directory,
      );
      return sendJson(res, list);
    }

    // `GET /session/status` (confirmed against a live opencode 1.17.13) ->
    // bare `{ [sessionID]: SessionStatus }`, no envelope. A quiet session is
    // simply absent from the map (not an explicit `{type:"idle"}` entry) --
    // see use-opencode.ts's `useSessionStatuses` comment.
    if (method === "GET" && path === "/session/status") {
      const statuses = Object.fromEntries(
        [...activeSessions].map((id) => [id, { type: "busy" as const }]),
      );
      return sendJson(res, statuses);
    }

    // `GET /agent` (legacy flat, bare array) -- the installed SDK's `Agent`
    // type (name/description/mode/permission/options/model) matches this
    // surface, not the newer enveloped `/api/agent` V2 catalog.
    if (method === "GET" && path === "/agent") {
      return sendJson(res, [
        {
          name: "build",
          description: "The default agent.",
          mode: "primary",
          permission: [],
          options: {},
        },
      ]);
    }

    // `GET /config/providers` (no /api prefix -- `/api/config/providers`
    // does not exist on real opencode) -> `{ providers: [...], default }`.
    if (method === "GET" && path === "/config/providers") {
      return sendJson(res, { providers: [], default: {} });
    }

    // Legacy flat permission/question surfaces (bare arrays) -- see
    // use-opencode.ts's `usePermissions`/`useQuestions` comment for why
    // these, not the newer per-session `/api/permission/request` V2 ones,
    // are what the app targets.
    if (method === "GET" && path === "/permission") return sendJson(res, []);
    if (method === "GET" && path === "/question") return sendJson(res, []);

    // `GET /vcs/diff/raw` (no /api prefix, same family as `/vcs/diff` and
    // `/vcs/status`) -- real opencode returns the working tree's unified
    // diff as a raw `text/x-diff` body, not JSON. This is what
    // use-opencode.ts's `useGitDiff` targets. A non-empty patch here, rather
    // than an empty string, lets the Diff view's `parsePatchFiles` +
    // `FileDiff` rendering path actually get exercised by e2e tests instead
    // of only hitting the "no changes" empty state.
    if (method === "GET" && path === "/vcs/diff/raw") {
      return sendText(
        res,
        [
          "diff --git a/README.md b/README.md",
          "index 8bcb179..f5127b4 100644",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1,1 +1,2 @@",
          " # OpenCode Mando",
          "+Stub diff line for e2e coverage.",
          "",
        ].join("\n"),
        "text/x-diff; charset=utf-8",
      );
    }
    if (method === "GET" && path === "/files/search") return sendJson(res, { data: [] });

    // `POST /session` (confirmed against a live opencode 1.17.13) -> bare
    // `Session`, no envelope. Real opencode has no `title` field on the
    // request (an extra one is silently dropped) -- the server always
    // assigns its own "New session - <ISO timestamp>" title. `directory`
    // (when the caller sends one -- see use-opencode.ts's `useCreateSession`)
    // lands the new session in that project instead of the default.
    if (method === "POST" && path === "/session") {
      const body = (await readJsonBody(req)) as { directory?: string };
      const id = stubId("ses");
      const now = Date.now();
      const session: StubSession = {
        id,
        slug: id,
        projectID: "stub-project",
        directory: body.directory || DEFAULT_DIRECTORY,
        title: `New session - ${new Date(now).toISOString()}`,
        version: "1.17.13",
        time: { created: now, updated: now },
      };
      sessions.set(id, session);
      messages.set(id, []);
      broadcast({ type: "session.created", properties: { sessionID: id, info: session } });
      return sendJson(res, session);
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)(.*)$/);
    if (sessionMatch) {
      const [, sessionId, rest] = sessionMatch;
      const session = sessions.get(sessionId);

      // `GET /session/:id/message` (confirmed against a live opencode
      // 1.17.13) -> a BARE ARRAY of `{info, parts}` -- see
      // use-session-messages.ts's `normalizeFetchedMessages`, which treats
      // this as the primary shape.
      if (method === "GET" && rest === "/message") {
        return sendJson(res, messages.get(sessionId) ?? []);
      }

      // `POST /session/:id/message` (confirmed against a live opencode
      // 1.17.13) accepts the model/agent/variant override directly in the
      // same request as the prompt (`{messageID?, model?:{providerID,
      // modelID}, agent?, variant?, parts}`) -- see $id.tsx's `sendMessage`.
      // Unlike the `/api/*` family, no separate model/agent call is needed
      // first.
      if (method === "POST" && rest === "/message" && session) {
        const body = (await readJsonBody(req)) as {
          messageID?: string;
          model?: { providerID?: string; modelID?: string };
          agent?: string;
          variant?: string;
          parts?: Array<{ type?: string; text?: string }>;
        };

        if (body.model?.providerID && body.model.modelID) {
          session.model = {
            id: body.model.modelID,
            providerID: body.model.providerID,
            ...(body.variant ? { variant: body.variant } : {}),
          };
        }
        if (body.agent) session.agent = body.agent;
        if (body.model || body.agent) touchSession(sessionId);

        const promptText =
          body.parts?.find((part) => part.type === "text")?.text ?? "";
        const messageId = body.messageID ?? stubId("msg");
        const now = Date.now();

        pushMessage(sessionId, {
          info: {
            id: messageId,
            sessionID: sessionId,
            role: "user",
            time: { created: now },
            agent: session.agent ?? "build",
            model: { providerID: "stub", modelID: "stub-model" },
          },
          parts: [
            {
              id: stubId("prt"),
              sessionID: sessionId,
              messageID: messageId,
              type: "text",
              text: promptText,
            },
          ],
        });

        broadcast({
          type: "session.next.prompted",
          properties: { timestamp: now, sessionID: sessionId, prompt: { text: promptText } },
        });

        // Fire the rest of the simulated turn after this response is sent
        // so the HTTP accept reaches the client before any SSE events it
        // triggers -- mirrors the real opencode/hub timing where the
        // accept response and the streamed events are independent.
        setImmediate(() => simulateAssistantTurn(sessionId, promptText));

        // Real opencode's response is the assistant message it is about to
        // produce (`{info, parts}`, parts empty until the turn streams in)
        // -- the caller here (`sendMessage` in $id.tsx) never reads this
        // body; content arrives over SSE instead.
        return sendJson(res, {
          info: {
            id: stubId("msg"),
            sessionID: sessionId,
            role: "assistant",
            time: { created: now },
          },
          parts: [],
        });
      }

      // `POST /session/:id/abort` (confirmed against a live opencode
      // 1.17.13) replaces the `/api/*` family's `/api/session/:id/interrupt`.
      if (method === "POST" && rest === "/abort") {
        activeSessions.delete(sessionId);
        return sendNoContent(res);
      }

      // `DELETE /session/:id` (confirmed against a live opencode 1.17.13,
      // bare boolean) -- the only real delete path; `/api/session/:id` only
      // supports GET.
      if (method === "DELETE" && rest === "") {
        const existed = sessions.get(sessionId);
        sessions.delete(sessionId);
        messages.delete(sessionId);
        activeSessions.delete(sessionId);
        if (existed) {
          broadcast({
            type: "session.deleted",
            properties: { sessionID: sessionId, info: existed },
          });
        }
        return sendJson(res, true);
      }
    }

    // Legacy flat reply/reject paths -- see the GET /permission and
    // GET /question handlers above for why these, not per-session V2
    // equivalents, are real.
    if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(path)) return sendJson(res, true);
    if (method === "POST" && /^\/question\/[^/]+\/reply$/.test(path)) return sendJson(res, true);
    if (method === "POST" && /^\/question\/[^/]+\/reject$/.test(path)) return sendJson(res, true);

    // `GET /event` (confirmed against a live opencode 1.17.13) -- SSE
    // stream, frame payload field `properties` (see `broadcast` above).
    if (method === "GET" && path === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id: stubId("evt"), type: "server.connected", properties: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // The `/api/*` family (session_message, server-created sessions only)
    // is NOT emulated here -- apps/web/src no longer calls it (see the
    // module comment). Loudly 404ing instead of silently ignoring means a
    // regression back to `/api/*` fails the e2e suite instead of passing
    // against a fake that's more forgiving than the real server.
    if (path.startsWith("/api/")) {
      return sendJson(res, { error: "wrong api family" }, 404);
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;

  return {
    port,
    async stop() {
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          // Already closed.
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

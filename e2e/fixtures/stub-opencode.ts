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
// `opencode serve` (v1.17.13) via its `/doc` OpenAPI spec and live curls --
// see .superpowers/sdd/opencode-api-fix-report.md for the full mapping.
// Two real-but-parallel API surfaces exist on that server: a newer `/api/*`
// one (enveloped `{ data: ... }` responses, richer session/message model)
// and a legacy flat one with no `/api` prefix and no envelope. This stub
// mirrors whichever surface apps/web/src actually calls for each concern
// (see each handler's comment) -- not "the /api one" uniformly, because the
// installed `@opencode-ai/sdk` (1.14.41) only models some endpoints in
// their legacy flat shape (agents, permissions, questions), and the app's
// rendering code was written against those types.
//
// Built on node:http, not Bun.serve: this module is imported directly by
// global-setup.ts, which Playwright's test runner loads and executes under
// a real Node.js process even when the whole suite is launched via
// `bunx playwright test` (see task-8.1-report.md, "Node vs Bun" -- Bun is
// simply not defined in that context). node:http covers everything this
// fake needs (plain JSON responses, one long-lived SSE stream), so there's
// no reason to fight the runtime here.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

interface StubSession {
  id: string;
  projectID: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; updated: number };
  title: string;
  location: { directory: string };
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
}

type StubMessage = Record<string, unknown>;

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

function stubEventId(): string {
  return `evt_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function startStubOpencode(): Promise<StubOpencode> {
  const sessions = new Map<string, StubSession>();
  const messages = new Map<string, StubMessage[]>();
  const activeSessions = new Set<string>();
  const sseClients = new Set<ServerResponse>();

  // Real `/api/event` frames are `data: {"id":"evt_...","type":"...","data":
  // {...}}` -- the payload field is named `data`, not `properties` (the
  // installed SDK's bundled types are stale on this point; see
  // use-opencode-events.ts's `RenameProperties`). Verified by reading raw
  // SSE bytes off a live opencode 1.17.13 server.
  function broadcast(event: { type: string; data: Record<string, unknown> }): void {
    const frame = { id: stubEventId(), ...event };
    const chunk = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of sseClients) {
      res.write(chunk);
    }
  }

  function pushMessage(sessionId: string, message: StubMessage): void {
    const list = messages.get(sessionId) ?? [];
    list.push(message);
    messages.set(sessionId, list);
  }

  function touchSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.time.updated = Date.now();
    broadcast({
      type: "session.updated",
      data: { sessionID: sessionId, info: session },
    });
  }

  // Simulates a short assistant turn (step -> streamed text -> step end ->
  // idle) so a Playwright spec awaiting streamed output has something real
  // to observe, without needing an actual model. The reply is split into
  // two `session.next.text.delta` events separated by a short delay, rather
  // than one delta carrying the whole reply -- task 8.2's session-drive
  // spec needs to assert that a *partial* chunk renders before the full
  // text does (content-based, not a wall-clock assertion: the test waits
  // for the first chunk's exact substring, then for the full reply, and
  // never asserts on timing itself). The delay is just what makes that
  // first, partial DOM state observable instead of collapsing into the
  // same 16ms client-side event batch as everything else (see
  // apps/web/src/hooks/use-opencode-events.ts's `enqueue`/`flush`).
  //
  // Once the turn ends, the finished assistant message is also recorded in
  // `messages` in the real `SessionMessage` shape (`GET
  // /api/session/:id/message` -- see hooks/use-session-messages.ts's
  // `normalizeFetchedMessages`). Without this, `session.idle`'s own
  // `revalidateMessagesNow` (a real behavior of the web app, not a test
  // artifact) would GET that endpoint a moment later and get back only the
  // user message, wiping the assistant text the SSE deltas had just
  // rendered.
  function simulateAssistantTurn(sessionId: string, promptText: string): void {
    const now = Date.now();
    const assistantMessageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
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
      data: {
        timestamp: now,
        sessionID: sessionId,
        assistantMessageID: assistantMessageId,
        agent: "build",
        model,
      },
    });
    broadcast({
      type: "session.next.text.started",
      data: { timestamp: now, sessionID: sessionId, assistantMessageID: assistantMessageId, textID: "t1" },
    });
    broadcast({
      type: "session.next.text.delta",
      data: {
        timestamp: now,
        sessionID: sessionId,
        assistantMessageID: assistantMessageId,
        textID: "t1",
        delta: firstChunk,
      },
    });

    setTimeout(() => {
      const later = Date.now();
      broadcast({
        type: "session.next.text.delta",
        data: {
          timestamp: later,
          sessionID: sessionId,
          assistantMessageID: assistantMessageId,
          textID: "t1",
          delta: secondChunk,
        },
      });
      broadcast({
        type: "session.next.text.ended",
        data: {
          timestamp: later,
          sessionID: sessionId,
          assistantMessageID: assistantMessageId,
          textID: "t1",
          text: replyText,
        },
      });
      broadcast({
        type: "session.next.step.ended",
        data: {
          timestamp: later,
          sessionID: sessionId,
          assistantMessageID: assistantMessageId,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      pushMessage(sessionId, {
        id: assistantMessageId,
        type: "assistant",
        agent: "build",
        model,
        content: [{ type: "text", text: replyText }],
        time: { created: now, completed: later },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      });
      activeSessions.delete(sessionId);
      broadcast({
        type: "session.idle",
        data: { sessionID: sessionId },
      });
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

    // `GET /api/session` -> `{ data: SessionV2Info[], cursor }`.
    if (method === "GET" && path === "/api/session") {
      return sendJson(res, { data: [...sessions.values()], cursor: {} });
    }

    // `GET /api/session/active` -> `{ data: { [sessionID]: { type:
    // "running" } } }` -- absent key means not running, not "idle".
    if (method === "GET" && path === "/api/session/active") {
      const data = Object.fromEntries(
        [...activeSessions].map((id) => [id, { type: "running" as const }]),
      );
      return sendJson(res, { data });
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
    // these, not the newer `/api/permission/request` V2 ones, are what the
    // app targets.
    if (method === "GET" && path === "/permission") return sendJson(res, []);
    if (method === "GET" && path === "/question") return sendJson(res, []);

    // `GET /vcs/diff/raw` (no /api prefix, same family as `/vcs/diff` and
    // `/vcs/status`) -- real opencode returns the working tree's unified
    // diff as a raw `text/x-diff` body, not JSON. This is what
    // use-opencode.ts's `useGitDiff` now targets (see its comment for why,
    // and why there's no `/git/diff` or `/api/vcs/diff`). A non-empty patch
    // here, rather than an empty string, lets the Diff view's
    // `parsePatchFiles` + `FileDiff` rendering path actually get exercised
    // by e2e tests instead of only hitting the "no changes" empty state.
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

    // `POST /api/session` -> `{ data: SessionV2Info }`. Real opencode's
    // request schema has no `title` field (an extra one is silently
    // dropped) -- the server always assigns its own "New session - <ISO
    // timestamp>" title, mirrored here.
    if (method === "POST" && path === "/api/session") {
      const id = `ses_${crypto.randomUUID().replace(/-/g, "")}`;
      const now = Date.now();
      const session: StubSession = {
        id,
        projectID: "stub-project",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
        title: `New session - ${new Date(now).toISOString()}`,
        location: { directory: "/tmp/mando-e2e" },
      };
      sessions.set(id, session);
      messages.set(id, []);
      broadcast({ type: "session.created", data: { sessionID: id, info: session } });
      return sendJson(res, { data: session });
    }

    const apiSessionMatch = path.match(/^\/api\/session\/([^/]+)(.*)$/);
    if (apiSessionMatch) {
      const [, sessionId, rest] = apiSessionMatch;
      const session = sessions.get(sessionId);

      if (method === "GET" && rest === "/message") {
        return sendJson(res, { data: messages.get(sessionId) ?? [], cursor: {} });
      }

      if (method === "POST" && rest === "/model" && session) {
        const body = (await readJsonBody(req)) as {
          model?: { id?: string; providerID?: string; variant?: string };
        };
        if (body.model?.id && body.model.providerID) {
          session.model = {
            id: body.model.id,
            providerID: body.model.providerID,
            ...(body.model.variant ? { variant: body.model.variant } : {}),
          };
          touchSession(sessionId);
        }
        return sendNoContent(res);
      }

      if (method === "POST" && rest === "/agent" && session) {
        const body = (await readJsonBody(req)) as { agent?: string };
        if (body.agent) {
          session.agent = body.agent;
          touchSession(sessionId);
        }
        return sendNoContent(res);
      }

      if (method === "POST" && rest === "/prompt" && session) {
        const body = (await readJsonBody(req)) as {
          id?: string;
          prompt?: { text?: string };
        };
        const promptText = body.prompt?.text ?? "";
        const messageId = body.id ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`;
        const now = Date.now();

        pushMessage(sessionId, {
          id: messageId,
          type: "user",
          text: promptText,
          time: { created: now },
        });

        broadcast({
          type: "session.next.prompted",
          data: {
            timestamp: now,
            sessionID: sessionId,
            messageID: messageId,
            prompt: { text: promptText },
          },
        });

        // Fire the rest of the simulated turn after this response is sent
        // so the HTTP accept reaches the client before any SSE events it
        // triggers -- mirrors the real opencode/hub timing where the
        // accept response and the streamed events are independent.
        setImmediate(() => simulateAssistantTurn(sessionId, promptText));

        return sendJson(res, {
          data: {
            admittedSeq: 0,
            id: messageId,
            sessionID: sessionId,
            prompt: { text: promptText },
            delivery: "steer",
            timeCreated: now,
          },
        });
      }

      if (method === "POST" && rest === "/interrupt") {
        activeSessions.delete(sessionId);
        return sendNoContent(res);
      }
    }

    // Legacy flat reply/reject paths -- see the GET /permission and
    // GET /question handlers above for why these, not
    // `/api/session/:id/permission|question/:id/reply`, are real.
    if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(path)) return sendJson(res, true);
    if (method === "POST" && /^\/question\/[^/]+\/reply$/.test(path)) return sendJson(res, true);
    if (method === "POST" && /^\/question\/[^/]+\/reject$/.test(path)) return sendJson(res, true);

    // `DELETE /session/:id` (legacy flat -- `/api/session/:id` only
    // supports GET on real opencode, there is no V2 delete) -> bare boolean.
    const legacySessionMatch = path.match(/^\/session\/([^/]+)$/);
    if (legacySessionMatch && method === "DELETE") {
      const [, sessionId] = legacySessionMatch;
      const existed = sessions.delete(sessionId);
      messages.delete(sessionId);
      activeSessions.delete(sessionId);
      if (existed) broadcast({ type: "session.deleted", data: { sessionID: sessionId } });
      return sendJson(res, true);
    }

    if (method === "GET" && path === "/api/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id: stubEventId(), type: "server.connected", data: {} })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
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

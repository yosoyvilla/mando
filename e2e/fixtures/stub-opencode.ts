// A minimal, in-process fake of a local `opencode` server -- the thing the
// real `mando` agent daemon forwards HTTP requests to on 127.0.0.1. It only
// implements the handful of paths the web UI actually calls through the
// hub's per-machine proxy (`HubClient.opencode(id).fetch/events`, see
// apps/web/src/lib/opencode-fetch.ts) plus `GET /doc`, which is not a proxy
// path at all -- it's what the agent's own `checkHealth()`
// (packages/agent/src/opencode.ts) polls directly against this port to
// decide the local opencode server is alive. Without a `/doc` response the
// daemon's health-check loop (packages/agent/src/daemon.ts) would mark the
// machine unreachable and tear down the tunnel ~45s into any test run.
//
// Exact paths were taken from grepping apps/web/src for every
// `opencodeJson`/`opencodeRequest`/`opencodeEvents` call site (see
// task-8.1-report.md) -- not guessed.
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
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: { created: number; updated: number };
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

export async function startStubOpencode(): Promise<StubOpencode> {
  const sessions = new Map<string, StubSession>();
  const messages = new Map<string, StubMessage[]>();
  const sseClients = new Set<ServerResponse>();

  function broadcast(event: { type: string; properties: Record<string, unknown> }): void {
    const frame = { id: crypto.randomUUID(), ...event };
    const chunk = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of sseClients) {
      res.write(chunk);
    }
  }

  // Simulates a short assistant turn (step -> streamed text -> step end ->
  // idle) so a Playwright spec awaiting streamed output has something real
  // to observe, without needing an actual model. Kept deliberately simple:
  // one text delta, not token-by-token.
  function simulateAssistantTurn(sessionId: string, promptText: string): void {
    const now = Date.now();
    const model = { id: "stub-model", providerID: "stub", variant: "default" };
    const replyText = `stub reply to: ${promptText}`;

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
      properties: { timestamp: now, sessionID: sessionId, delta: replyText },
    });
    broadcast({
      type: "session.next.text.ended",
      properties: { timestamp: now, sessionID: sessionId, text: replyText },
    });
    broadcast({
      type: "session.next.step.ended",
      properties: {
        timestamp: now,
        sessionID: sessionId,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    broadcast({
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
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

    if (method === "GET" && path === "/sessions") return sendJson(res, [...sessions.values()]);

    if (method === "GET" && path === "/session/status") {
      const statuses = Object.fromEntries([...sessions.keys()].map((id) => [id, { type: "idle" }]));
      return sendJson(res, statuses);
    }

    if (method === "GET" && path === "/providers") return sendJson(res, []);
    if (method === "GET" && path === "/agents") return sendJson(res, []);
    if (method === "GET" && path === "/permissions") return sendJson(res, []);
    if (method === "GET" && path === "/questions") return sendJson(res, []);
    if (method === "GET" && path === "/git/diff") return sendJson(res, { diff: "", worktree: "" });
    if (method === "GET" && path === "/files/search") return sendJson(res, { data: [] });

    if (method === "POST" && path === "/session/create") {
      const body = (await readJsonBody(req)) as { title?: string };
      const id = crypto.randomUUID();
      const now = Date.now();
      const session: StubSession = {
        id,
        slug: id,
        projectID: "stub-project",
        directory: "/tmp/mando-e2e",
        title: body.title || "New session",
        version: "stub",
        time: { created: now, updated: now },
      };
      sessions.set(id, session);
      messages.set(id, []);
      broadcast({ type: "session.created", properties: { sessionID: id, info: session } });
      return sendJson(res, session, 201);
    }

    const sessionMatch = path.match(/^\/session\/([^/]+)(.*)$/);
    if (sessionMatch) {
      const [, sessionId, rest] = sessionMatch;

      if (method === "DELETE" && rest === "") {
        const existed = sessions.delete(sessionId);
        messages.delete(sessionId);
        if (existed) broadcast({ type: "session.deleted", properties: { sessionID: sessionId } });
        return sendJson(res, { ok: true });
      }

      if (method === "GET" && rest === "/messages") {
        return sendJson(res, messages.get(sessionId) ?? []);
      }

      if (method === "POST" && rest === "/prompt") {
        const body = (await readJsonBody(req)) as { text?: string; messageID?: string };
        const promptText = body.text ?? "";
        const messageId = body.messageID ?? crypto.randomUUID();
        const now = Date.now();

        const userMessage: StubMessage = { id: messageId, type: "user", text: promptText, time: { created: now } };
        const list = messages.get(sessionId) ?? [];
        list.push(userMessage);
        messages.set(sessionId, list);

        broadcast({
          type: "session.next.prompted",
          properties: { timestamp: now, sessionID: sessionId, prompt: { text: promptText } },
        });

        // Fire the rest of the simulated turn after this response is sent
        // so the HTTP accept reaches the client before any SSE events it
        // triggers -- mirrors the real opencode/hub timing where the
        // accept response and the streamed events are independent.
        setImmediate(() => simulateAssistantTurn(sessionId, promptText));

        return sendJson(res, { accepted: true, mode: "v2", messageID: messageId });
      }

      if (method === "POST" && rest === "/abort") return sendJson(res, { ok: true });
    }

    if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(path)) return sendJson(res, { ok: true });
    if (method === "POST" && /^\/question\/[^/]+\/reply$/.test(path)) return sendJson(res, { ok: true });
    if (method === "POST" && /^\/question\/[^/]+\/reject$/.test(path)) return sendJson(res, { ok: true });

    if (method === "GET" && path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ id: crypto.randomUUID(), type: "server.connected", properties: {} })}\n\n`);
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

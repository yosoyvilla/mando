import { createBunWebSocket } from "hono/bun";
import type postgres from "postgres";
import { parseFrame, serializeFrame, type Frame } from "@mando/protocol";
import { findMachineByToken } from "../machines/repo";
import type { Registry, Conn } from "./registry";

type Sql = ReturnType<typeof postgres>;

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_MISSED_PINGS = 2;

export type TunnelWsDeps = {
  sql: Sql;
  registry: Registry;
  // Injectable so tests don't have to wait out the real 30s ping cadence /
  // 5s hello grace period -- see task-2.7-report.md for the rationale.
  pingIntervalMs?: number;
  helloTimeoutMs?: number;
};

// createBunWebSocket() returns a stateless dispatcher pair: `websocket` just
// reads per-socket listeners off `ws.data.events` (populated by
// `upgradeWebSocket` at upgrade time), so one shared instance for the whole
// process is correct -- there is no per-connection or per-app state living
// on this pair itself. `websocket` must be passed to Bun.serve({ websocket })
// by whoever starts the server (src/index.ts in task 2.9, or
// test/helpers/server.ts here); it is re-exported from src/app.ts.
export const { upgradeWebSocket, websocket } = createBunWebSocket();

function errorFrame(code: string, message: string): Frame {
  return { type: "error", id: crypto.randomUUID(), payload: { code, message } };
}

// tunnelWsHandler builds the Hono route handler for /ws/agent, wired to the
// given deps (sql for token lookup + last_seen_at, and the shared Registry
// instance so this connection becomes visible to routes/proxy immediately).
export function tunnelWsHandler(deps: TunnelWsDeps) {
  const pingIntervalMs = deps.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

  return upgradeWebSocket(() => {
    // Per-connection state, closed over by the handlers below.
    let machineId: string | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let unansweredPings = 0;
    // Guards against a second `hello` frame arriving while the first is
    // still awaiting findMachineByToken -- until that await resolves,
    // machineId is still null, so onMessage's `!machineId` check alone
    // would let a second hello call handleHello again and overwrite
    // pingTimer, leaking the first interval. Set synchronously (before
    // any await) so a re-entrant call sees it immediately.
    let helloInProgress = false;
    // Response frames (response_begin/chunk/end/error) are routed back to
    // whoever is waiting on that request id -- task 2.8's proxy registers
    // these via Conn.onResponse. Terminal frames clean up their own entry.
    const responseHandlers = new Map<string, (frame: Frame) => void>();

    function stopTimers(): void {
      if (helloTimer) clearTimeout(helloTimer);
      if (pingTimer) clearInterval(pingTimer);
      helloTimer = null;
      pingTimer = null;
    }

    // Errors every in-flight response handler registered by proxyRequest
    // (apps/hub/src/tunnel/proxy.ts) for this connection, then drops them.
    // Without this, a WS teardown (close/error/ping-timeout) while a
    // request is mid-flight leaves proxyRequest's ReadableStream controller
    // open forever -- a browser reading an SSE response would hang until
    // its own transport eventually times out (or never). Delivering a
    // synthetic response_error mirrors exactly what a real agent-sent
    // response_error does: resolves proxyRequest's promise as a 502 if
    // response_begin never arrived, or errors the open stream if it did --
    // either way the browser's fetch/reader settles instead of hanging.
    function failInFlightResponses(): void {
      if (responseHandlers.size === 0) return;
      const entries = [...responseHandlers.entries()];
      responseHandlers.clear();
      for (const [id, handler] of entries) {
        handler({
          type: "response_error",
          id,
          payload: { code: "agent_disconnected", message: "the agent's tunnel connection closed" },
        });
      }
    }

    function unregister(): void {
      stopTimers();
      failInFlightResponses();
      if (machineId) {
        deps.registry.remove(machineId);
        machineId = null;
      }
    }

    async function handleHello(
      frame: Extract<Frame, { type: "hello" }>,
      ws: { send(data: string): void; close(code?: number, reason?: string): void },
    ): Promise<void> {
      if (helloInProgress) {
        // A duplicate hello while the first is still being verified --
        // ignore it rather than double-registering and leaking a second
        // ping interval.
        return;
      }
      helloInProgress = true;

      if (helloTimer) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }

      // findMachineByToken already scopes to non-revoked tokens on
      // non-revoked machines, so a non-null result is sufficient here.
      const machine = await findMachineByToken(deps.sql, frame.payload.token);
      if (!machine) {
        ws.send(serializeFrame(errorFrame("unauthorized", "invalid or revoked machine token")));
        ws.close(1008, "unauthorized");
        return;
      }

      machineId = machine.id;

      const conn: Conn = {
        send(f) {
          ws.send(serializeFrame(f));
        },
        onResponse(id, handler) {
          responseHandlers.set(id, handler);
        },
        offResponse(id) {
          responseHandlers.delete(id);
        },
        close() {
          ws.close();
        },
      };
      deps.registry.add(machineId, conn);

      ws.send(serializeFrame({ type: "registered", id: frame.id, payload: { machineId } }));

      unansweredPings = 0;
      pingTimer = setInterval(() => {
        if (unansweredPings >= MAX_MISSED_PINGS) {
          unregister();
          ws.close(1001, "ping timeout");
          return;
        }
        unansweredPings++;
        ws.send(serializeFrame({ type: "ping", id: crypto.randomUUID() }));
      }, pingIntervalMs);
    }

    async function handleStatus(): Promise<void> {
      if (!machineId) return;
      // No machines-repo helper for this exists yet, and there is no
      // health column in migrations/001_init.sql to persist
      // frame.payload.opencodeHealthy against -- per the task brief,
      // update last_seen_at directly via sql. Online/offline (the only
      // health signal routes currently expose) comes from
      // Registry.get(id) instead; wire a health column through here if a
      // future task needs opencodeHealthy surfaced in machine responses.
      await deps.sql`update machines set last_seen_at = now() where id = ${machineId}`;
    }

    return {
      onOpen(_evt, ws) {
        helloTimer = setTimeout(() => {
          ws.send(serializeFrame(errorFrame("hello_timeout", "expected a hello frame within 5s")));
          ws.close(1008, "hello timeout");
        }, helloTimeoutMs);
      },
      onMessage(evt, ws) {
        const raw = typeof evt.data === "string" ? evt.data : null;
        if (raw === null) return; // binary frames aren't part of this protocol; ignore.

        let frame: Frame;
        try {
          frame = parseFrame(raw);
        } catch {
          // Malformed/unparseable frame -- ignore rather than crash the
          // connection. A misbehaving or out-of-date agent should never be
          // able to take down the hub process.
          return;
        }

        if (!machineId) {
          if (frame.type === "hello") void handleHello(frame, ws);
          // Anything else before registration is ignored; the hello timer
          // above still fires if a valid hello never arrives.
          return;
        }

        switch (frame.type) {
          case "pong":
            unansweredPings = 0;
            return;
          case "status":
            void handleStatus();
            return;
          case "response_begin":
          case "response_chunk":
          case "response_end":
          case "response_error": {
            const handler = responseHandlers.get(frame.id);
            if (frame.type === "response_end" || frame.type === "response_error") {
              responseHandlers.delete(frame.id);
            }
            handler?.(frame);
            return;
          }
          default:
            // hello/registered/error/ping/http_request/cancel are not
            // expected from the agent post-registration; ignore safely.
            return;
        }
      },
      onClose() {
        unregister();
      },
      onError() {
        unregister();
      },
    };
  });
}

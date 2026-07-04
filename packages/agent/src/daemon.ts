import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseFrame, serializeFrame, PROTOCOL_VERSION, type Frame } from "@mando/protocol";
import { readConfig } from "./config";
import { nextDelay as defaultNextDelay } from "./reconnect";
import { checkHealth as defaultCheckHealth } from "./opencode";
import { forward } from "./forward";

// Kept in one place (matching the agent's package.json) rather than wired
// through build tooling -- this is the only place it's used (the `hello`
// frame's `agentVersion` field is informational for the hub, not parsed).
const AGENT_VERSION = "0.1.0";

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15_000;
// How many consecutive failed local-opencode health probes it takes
// before the daemon gives up on this session and exits. At the default
// 15s interval that's 45s of the local opencode server being completely
// unreachable -- long enough to ride out a brief restart/reload, short
// enough that a genuinely closed opencode session doesn't leave a daemon
// (and its open hub tunnel) running forever.
const DEFAULT_MAX_CONSECUTIVE_HEALTH_FAILURES = 3;

export function defaultPidFilePath(): string {
  return process.env.MANDO_PID_FILE ?? join(homedir(), ".mando-pid");
}

export function writePidFile(path: string, pid: number): void {
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  writeFileSync(path, String(pid), "utf-8");
}

export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone -- fine, disconnect()/a previous stop() may have
    // removed it already.
  }
}

// True if a process with this pid exists and is signalable by us. Sending
// signal 0 is the standard POSIX/Node idiom for a liveness check -- it
// delivers no actual signal, just runs the permission/existence checks
// `kill` would otherwise do. Shared by connect() (to avoid spawning a
// second daemon over an already-running one), disconnect(), and status().
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Tiny on-disk record of when this machine was last known to be alive
// (last successful local-opencode health check, or last successful
// registration with the hub) -- read by status() to answer "when did we
// last hear from this daemon" without touching the network. Mirrors the
// pidfile pattern above: a single small file, env-overridable for tests.
export interface DaemonState {
  lastSeenAt: string;
}

export function defaultStateFilePath(): string {
  return process.env.MANDO_STATE_FILE ?? join(homedir(), ".mando-state.json");
}

export function readStateFile(path: string): DaemonState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.lastSeenAt === "string" ? { lastSeenAt: parsed.lastSeenAt } : null;
  } catch {
    return null;
  }
}

export function writeLastSeen(path: string, at: Date = new Date()): void {
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ lastSeenAt: at.toISOString() } satisfies DaemonState), "utf-8");
}

// Tiny on-disk record of the last fatal (non-retryable) hub ErrorFrame this
// daemon received -- e.g. version_mismatch or unauthorized. The daemon runs
// fully detached with its stdio discarded (see connect.ts's
// defaultSpawnDaemon), so printing to console isn't enough to surface a
// same-tick-fast rejection back to a `mando connect` invocation still
// running in the foreground; this file is the channel connect() polls
// instead (see connect.ts). Also read by status() for later inspection.
export interface DaemonFatalError {
  code: string;
  message: string;
  at: string;
}

export function defaultErrorFilePath(): string {
  return process.env.MANDO_ERROR_FILE ?? join(homedir(), ".mando-error.json");
}

export function readLastError(path: string): DaemonFatalError | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed?.code === "string" && typeof parsed?.message === "string"
      ? { code: parsed.code, message: parsed.message, at: typeof parsed.at === "string" ? parsed.at : "" }
      : null;
  } catch {
    return null;
  }
}

export function writeLastError(path: string, error: { code: string; message: string }): void {
  const parentDir = dirname(path);
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
  const record: DaemonFatalError = { ...error, at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(record), "utf-8");
}

export function clearLastError(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone -- fine, nothing to clear.
  }
}

// The subset of the WebSocket client interface the daemon loop actually
// uses. `WebSocket` (Bun's global, spec-shaped client) satisfies this
// structurally, so the real default (`(url) => new WebSocket(url)`) needs
// no cast -- but tests can hand `runDaemon` a much smaller fake that only
// implements these four members, without a real socket or network at all.
export interface DaemonSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (evt: any) => void): void;
}

export type DaemonEvent =
  | { type: "connecting"; attempt: number }
  | { type: "registered"; machineId: string }
  | { type: "hub_error"; code: string; message: string }
  | { type: "reconnect_scheduled"; attempt: number; delayMs: number }
  | { type: "health_check"; healthy: boolean; consecutiveFailures: number }
  | { type: "stopped"; reason: string };

export interface DaemonOptions {
  hubUrl: string;
  token: string;
  machineName: string;
  opencodePort: number;
  agentVersion?: string;
  opencodePassword?: string;
  pidFile?: string;
  stateFile?: string;
  errorFile?: string;
  // All of the below are injection points for tests -- so the message
  // loop, reconnect backoff, and health polling can be driven
  // deterministically and fast, without a real socket, real opencode
  // server, or waiting out real backoff/interval delays.
  wsFactory?: (url: string) => DaemonSocket;
  nextDelay?: (attempt: number) => number;
  checkHealth?: (port: number) => Promise<boolean>;
  healthCheckIntervalMs?: number;
  maxConsecutiveHealthFailures?: number;
  // External stop signal. The real detached-process entrypoint (see
  // `import.meta.main` below) wires SIGTERM/SIGINT into an AbortController
  // and passes its signal here, so OS-signal handling stays outside the
  // loop logic and `runDaemon` itself stays testable by simply calling
  // `controller.abort()`.
  signal?: AbortSignal;
  onEvent?: (event: DaemonEvent) => void;
}

// runDaemon is the long-running WS message loop described in the task
// brief: connect -> hello -> registered, then dispatch ping/http_request/
// cancel/status for as long as the connection (and the local opencode
// server) stays alive, reconnecting with `nextDelay` backoff on any drop.
// It resolves -- it never calls `process.exit` itself -- when the loop
// decides to stop: an unrecoverable hub error (e.g. a revoked token),
// `opts.signal` firing, or `maxConsecutiveHealthFailures` consecutive
// failed local-opencode health probes. Not calling process.exit keeps this
// function directly unit-testable in-process; the `import.meta.main` block
// below is what actually exits the process when this runs as the spawned
// detached child.
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const {
    hubUrl,
    token,
    machineName,
    opencodePort,
    agentVersion = AGENT_VERSION,
    opencodePassword,
    pidFile = defaultPidFilePath(),
    stateFile = defaultStateFilePath(),
    errorFile = defaultErrorFilePath(),
    wsFactory = (url: string) => new WebSocket(url),
    nextDelay = defaultNextDelay,
    checkHealth = defaultCheckHealth,
    healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    maxConsecutiveHealthFailures = DEFAULT_MAX_CONSECUTIVE_HEALTH_FAILURES,
    signal,
    onEvent = () => {},
  } = opts;

  writePidFile(pidFile, process.pid);
  // A fresh daemon run has no fatal error yet -- clear any stale record a
  // previous run left behind so connect()'s post-spawn check (see
  // connect.ts) never reports an old failure as if it were this run's.
  clearLastError(errorFile);

  let stopped = false;
  let attempt = 0;
  let consecutiveHealthFailures = 0;
  let socket: DaemonSocket | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // One AbortController per in-flight http_request id, so a `cancel`
  // frame for that id can abort exactly that forward() call (and nothing
  // else) -- see forward.ts's `signal` option.
  const inFlight = new Map<string, AbortController>();

  function stop(reason: string): void {
    if (stopped) return;
    stopped = true;
    if (healthTimer) clearInterval(healthTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    for (const controller of inFlight.values()) controller.abort();
    inFlight.clear();
    socket?.close();
    removePidFile(pidFile);
    onEvent({ type: "stopped", reason });
  }

  return new Promise<void>((resolve) => {
    function finish(reason: string): void {
      stop(reason);
      resolve();
    }

    signal?.addEventListener("abort", () => finish("signal"), { once: true });

    healthTimer = setInterval(() => {
      if (stopped) return;
      void checkHealth(opencodePort).then((healthy) => {
        if (stopped) return;
        consecutiveHealthFailures = healthy ? 0 : consecutiveHealthFailures + 1;
        if (healthy) writeLastSeen(stateFile);
        onEvent({ type: "health_check", healthy, consecutiveFailures: consecutiveHealthFailures });

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            serializeFrame({ type: "status", id: crypto.randomUUID(), payload: { opencodeHealthy: healthy } }),
          );
        }

        if (consecutiveHealthFailures >= maxConsecutiveHealthFailures) {
          finish("opencode_unreachable");
        }
      });
    }, healthCheckIntervalMs);

    function scheduleReconnect(): void {
      if (stopped) return;
      const delayMs = nextDelay(attempt);
      onEvent({ type: "reconnect_scheduled", attempt, delayMs });
      attempt++;
      reconnectTimer = setTimeout(() => {
        if (!stopped) connectOnce();
      }, delayMs);
    }

    function connectOnce(): void {
      if (stopped) return;
      onEvent({ type: "connecting", attempt });
      const wsUrl = `${hubUrl.replace(/^http/, "ws")}/ws/agent`;
      const ws = wsFactory(wsUrl);
      socket = ws;

      ws.addEventListener("open", () => {
        if (stopped) return;
        ws.send(
          serializeFrame({
            type: "hello",
            id: crypto.randomUUID(),
            payload: { token, machineName, opencodePort, agentVersion, protocolVersion: PROTOCOL_VERSION },
          }),
        );
      });

      ws.addEventListener("message", (evt: { data: unknown }) => {
        if (stopped) return;
        const raw = typeof evt.data === "string" ? evt.data : null;
        if (raw === null) return;

        let frame: Frame;
        try {
          frame = parseFrame(raw);
        } catch {
          return; // malformed frame from the hub -- ignore, don't crash the loop.
        }

        switch (frame.type) {
          case "registered":
            attempt = 0;
            writeLastSeen(stateFile);
            onEvent({ type: "registered", machineId: frame.payload.machineId });
            return;
          case "error":
            // The hub only ever sends this for hello_timeout/unauthorized/
            // version_mismatch (see apps/hub/src/tunnel/ws.ts) -- all three
            // are unrecoverable by reconnecting with the same token/agent
            // build, so stop rather than loop forever hammering the hub
            // with the same bad credentials or incompatible version.
            // Persisted to disk (not just onEvent) because the real
            // detached daemon's stdio is discarded -- see connect.ts's
            // defaultSpawnDaemon and its post-spawn check.
            writeLastError(errorFile, { code: frame.payload.code, message: frame.payload.message });
            onEvent({ type: "hub_error", code: frame.payload.code, message: frame.payload.message });
            finish(`hub_error:${frame.payload.code}`);
            return;
          case "ping":
            ws.send(serializeFrame({ type: "pong", id: frame.id }));
            return;
          case "http_request": {
            const controller = new AbortController();
            inFlight.set(frame.id, controller);
            void forward(frame, `http://127.0.0.1:${opencodePort}`, (f) => ws.send(serializeFrame(f)), {
              opencodePassword,
              signal: controller.signal,
            }).finally(() => {
              inFlight.delete(frame.id);
            });
            return;
          }
          case "cancel":
            inFlight.get(frame.id)?.abort();
            return;
          default:
            // hello/response_*/pong/status are never sent hub -> agent.
            return;
        }
      });

      ws.addEventListener("close", () => {
        if (socket === ws) socket = null;
        if (stopped) return;
        // Transient drop (hub restart, network blip) -- not the terminal
        // stop() path (that already aborted+cleared inFlight itself, and
        // returned above via the `stopped` check). Any http_request still
        // being forwarded against local opencode is now bound to a `send`
        // callback that writes to a dead socket, so abort it here rather
        // than let it keep running to a response nobody will ever see.
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
        scheduleReconnect();
      });

      // 'close' always fires after 'error' for a WebSocket, so
      // reconnection is handled by the close handler above; nothing
      // additional to do here beyond not crashing.
      ws.addEventListener("error", () => {});
    }

    connectOnce();
  });
}

if (import.meta.main) {
  void (async () => {
    const args = process.argv.slice(2);
    const portIndex = args.indexOf("--opencode-port");
    const opencodePort = portIndex >= 0 ? Number(args[portIndex + 1]) : NaN;
    if (!Number.isInteger(opencodePort) || opencodePort <= 0) {
      console.error("mando daemon: missing or invalid --opencode-port");
      process.exit(1);
    }

    const config = readConfig();
    if (!config || !config.token) {
      console.error("mando daemon: no token configured; run `mando connect` first");
      process.exit(1);
    }

    const controller = new AbortController();
    process.on("SIGTERM", () => controller.abort());
    process.on("SIGINT", () => controller.abort());

    await runDaemon({
      hubUrl: config.hubUrl,
      token: config.token,
      machineName: config.machineName,
      opencodePort,
      opencodePassword: process.env.MANDO_OPENCODE_PASSWORD,
      // Without this, a fatal hub rejection (version_mismatch,
      // unauthorized, hello_timeout) was silently swallowed here: runDaemon
      // defaults `onEvent` to a no-op, so nothing was ever printed for
      // whoever is watching this process's own stderr (e.g. it run in the
      // foreground for debugging, not through connect()'s detached spawn
      // with stdio discarded -- that path relies on the error file instead,
      // see connect.ts).
      onEvent: (event) => {
        if (event.type === "hub_error") {
          console.error(`mando daemon: ${event.message}`);
        }
      },
      signal: controller.signal,
    });

    process.exit(0);
  })();
}

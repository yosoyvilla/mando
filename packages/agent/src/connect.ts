import { hostname } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig, type AgentConfig } from "./config";
import { detectOpencodePort as defaultDetectOpencodePort, ensureOpencodeServer as defaultEnsureOpencodeServer } from "./opencode";
import {
  clearLastError,
  defaultErrorFilePath,
  defaultPidFilePath,
  isProcessAlive as defaultIsProcessAlive,
  readLastError,
  readPidFile,
  writePidFile,
} from "./daemon";

// How long to give the freshly-spawned daemon a chance to hit an
// immediate, fatal hub rejection (version_mismatch, unauthorized,
// hello_timeout) before connect() reports "connected" -- see the
// post-spawn check below for why this is safe/bounded rather than a
// vague "wait and hope" delay.
const DEFAULT_POST_SPAWN_GRACE_MS = 250;

export interface ConnectOpts {
  json?: boolean;
  // When detection (opts.opencodePort ?? detectOpencodePort()) finds
  // nothing, this gates whether connect() starts a local `opencode serve`
  // itself (via ensureOpencodeServer) instead of failing outright -- see
  // the opencodePort resolution block below. An explicit --opencode-port
  // always bypasses both detection and this flag.
  opencodeAuto?: boolean;
  opencodePort?: number;
  args?: string[];
  // Not in the brief's minimal shape, but a natural home for the `--hub`
  // flag / MANDO_HUB env override index.ts's CLI parser extracts -- kept
  // here (rather than parsed a second time inside connect()) so opts stays
  // the single source of truth for everything the CLI layer already knew.
  hub?: string;
  // Not used by connect() itself -- a home for the `--dir` flag index.ts's
  // CLI parser extracts for `mando tui` (see tui.ts), kept here for the
  // same reason as `hub` above: opts stays the single source of truth for
  // everything the CLI layer already parsed, instead of index.ts parsing
  // argv a second time per-subcommand.
  dir?: string;
  // Test-only injection points (see task-3.4-report.md "How the daemon
  // spawn is tested"). None of these change connect()'s documented
  // behavior; they only let tests swap the real network/process calls for
  // deterministic stand-ins.
  pairingPollIntervalMs?: number;
  fetchFn?: typeof fetch;
  detectOpencodePort?: () => Promise<number | null>;
  ensureOpencodeServer?: (directory: string) => Promise<number>;
  spawnDaemon?: (opencodePort: number, connectDirectory: string) => number;
  // Swaps out the real POSIX liveness check (daemon.ts's `isProcessAlive`,
  // itself `process.kill(pid, 0)` in a try/catch) used by the
  // already-running-daemon guard below, so tests can simulate a live or
  // dead pid without depending on real OS process ids.
  isProcessAlive?: (pid: number) => boolean;
  // Test-only injection points for the post-spawn fatal-error check (see
  // connect()'s doc comment below). Not part of connect()'s documented
  // behavior beyond letting tests skip the real delay.
  errorFile?: string;
  postSpawnGraceMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export type ConnectResult =
  | { status: "connected"; machine: string; uiUrl: string; alreadyRunning?: boolean }
  | { status: "error"; message: string };

type PairingRequestResponse = { code: string; expiresAt: string };
type PairingStatusResponse = { status: "pending" | "approved"; token?: string };

// Distinguishes *why* polling stopped without a token, so connect() can
// report an accurate message instead of always saying "expired" -- see
// pollUntilApproved's doc comment for why "approved without a token" is a
// distinct, non-retryable-by-waiting outcome from "the deadline passed
// while still pending".
type PollOutcome =
  | { status: "approved"; token: string }
  | { status: "expired" }
  | { status: "approved_without_token" };

const DEFAULT_PAIRING_POLL_INTERVAL_MS = 2000;

function printResult(json: boolean | undefined, payload: Record<string, unknown>, human: string): void {
  if (json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(human);
  }
}

function resolveHubUrl(opts: ConnectOpts, config: AgentConfig | null): string | null {
  return opts.hub ?? config?.hubUrl ?? process.env.MANDO_HUB ?? null;
}

async function requestPairing(
  fetchFn: typeof fetch,
  hubUrl: string,
  machineName: string,
): Promise<PairingRequestResponse> {
  const res = await fetchFn(`${hubUrl}/api/v1/pairing/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineName, platform: process.platform }),
  });
  if (!res.ok) throw new Error(`pairing request failed with status ${res.status}`);
  return (await res.json()) as PairingRequestResponse;
}

// Polls GET /api/v1/pairing/status until the pairing code is approved (in
// which case the freshly-minted machine token is returned), the hub
// reports it approved but WITHOUT a token, or its expiresAt deadline
// passes. A non-2xx, non-410 response (a transient network/hub hiccup) is
// treated as "still pending" rather than a hard failure -- one bad poll
// shouldn't abort an otherwise-successful pairing the user is about to
// approve in the browser.
//
// "approved without a token" stops polling immediately rather than
// continuing until the deadline: once the hub reports the code as
// approved, it will never mint a second token for it (pairing/service.ts
// treats a code as consumed), so a token-less "approved" response means
// the token was already handed out and lost in transit (e.g. this specific
// poll response was dropped by the network) -- more polling cannot recover
// it, and letting the loop run out the clock would misreport an actually-
// successful pairing as "expired".
async function pollUntilApproved(
  fetchFn: typeof fetch,
  hubUrl: string,
  code: string,
  expiresAt: string,
  pollIntervalMs: number,
): Promise<PollOutcome> {
  const deadline = new Date(expiresAt).getTime();

  while (Date.now() < deadline) {
    const res = await fetchFn(`${hubUrl}/api/v1/pairing/status?code=${encodeURIComponent(code)}`);
    if (res.status === 410) return { status: "expired" }; // expired -- no point continuing to poll.
    if (res.ok) {
      try {
        const body = (await res.json()) as PairingStatusResponse;
        if (body.status === "approved") {
          if (body.token) return { status: "approved", token: body.token };
          return { status: "approved_without_token" };
        }
      } catch {
        // Unparseable body on an otherwise-2xx poll -- treat as "still
        // pending" rather than letting a JSON parse error escape connect()
        // as an unhandled rejection over a transient hub hiccup.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { status: "expired" };
}

// True while this code is running inside a `bun build --compile` binary.
// Verified against bun 1.3.14: inside a compiled standalone executable,
// import.meta.dir is a virtual `/$bunfs/...` path rather than a real
// on-disk directory -- there is no `Bun.isStandaloneExecutable` (checked;
// it does not exist on this bun version) to ask directly instead.
function runningFromCompiledBinary(): boolean {
  return import.meta.dir.startsWith("/$bunfs");
}

// Spawns the detached daemon child (see daemon.ts's runDaemonMain) that
// owns the actual WS connection/forward loop for the rest of this
// "session". Per Bun's own docs, `detached: true` alone does not let the
// parent exit before the child -- `stdio: ["ignore","ignore","ignore"]`
// (so no inherited pipe keeps the parent alive waiting to drain it) AND
// calling `proc.unref()` are both required; see the SpawnOptions.detached
// doc comment in bun-types (node_modules/.../bun-types/bun.d.ts).
//
// The child is the current executable re-exec'd with a hidden `_daemon`
// argv rather than `bun daemon.ts` directly: inside a released, compiled
// `mando` binary (`bun build --compile`) there is no daemon.ts on disk for
// `bun` to run -- import.meta.dir there is a virtual `/$bunfs/...` path --
// so `process.execPath` (the mando binary itself) is re-invoked with
// `_daemon` (see index.ts's hidden dispatch), which runs the exact same
// runDaemonMain() in-process instead. Running from source, `process
// .execPath` is the `bun` binary, so index.ts still needs to be named
// explicitly as the entrypoint.
//
// `--connect-dir` carries connect()'s own `process.cwd()` (the directory
// `mando connect` was run from) through to the daemon, which forwards it
// verbatim in the hello frame's payload -- see daemon.ts's runDaemonMain
// and DaemonOptions.connectDirectory. Sent unconditionally here (connect()
// always knows its own cwd), but daemon.ts still treats it as optional on
// the parsing side, since a daemon can also be started by other argv that
// predates or omits this flag.
//
// The pidfile is written here, synchronously, using `proc.pid` -- not
// deferred to the child writing its own pidfile once its event loop gets
// around to it -- so that by the time connect() returns and prints
// "connected", `disconnect()`/`status()` can already find it. daemon.ts's
// own runDaemon() also writes the same pidfile at startup (see its
// module comment); since the child is spawned directly with no
// intermediate shell, `proc.pid` and the daemon's own `process.pid` are
// the same process, so this is a redundant-but-harmless overwrite with an
// identical value, not a race.
export function defaultSpawnDaemon(opencodePort: number, connectDirectory: string): number {
  const daemonArgs = ["_daemon", "--opencode-port", String(opencodePort), "--connect-dir", connectDirectory];
  const args = runningFromCompiledBinary()
    ? [process.execPath, ...daemonArgs]
    : [process.execPath, join(import.meta.dir, "index.ts"), ...daemonArgs];

  const proc = Bun.spawn(args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    // Bun.spawn's `env` defaults to a snapshot of process.env taken when
    // *this* bun process launched -- runtime mutations (e.g. MANDO_CONFIG/
    // MANDO_PID_FILE overrides set by a caller or a test) are invisible to
    // that default. Spreading process.env explicitly here means the child
    // sees the current env as of this call, including MANDO_HUB/
    // MANDO_CONFIG/MANDO_PID_FILE/MANDO_OPENCODE_PASSWORD overrides.
    env: { ...process.env },
  });
  proc.unref();
  writePidFile(defaultPidFilePath(), proc.pid);
  return proc.pid;
}

// connect() implements the full task-3.4 flow: pair (if no token yet),
// detect the local opencode server, spawn the detached daemon, and return
// quickly -- it never itself holds the hub WS connection open. See
// task-3.4-report.md for the pairing-poll and daemon-spawn test strategy.
//
// Before spawning, it checks the same pidfile disconnect()/status() trust
// (see daemon.ts's isProcessAlive) for an already-running daemon -- e.g. a
// second `/mando` invocation in the same opencode session -- so repeat
// calls report the existing connection instead of leaking another detached
// process and opening a second tunnel for the same machine.
export async function connect(opts: ConnectOpts = {}): Promise<ConnectResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const detectOpencodePort = opts.detectOpencodePort ?? defaultDetectOpencodePort;
  const ensureOpencodeServer = opts.ensureOpencodeServer ?? defaultEnsureOpencodeServer;
  const spawnDaemon = opts.spawnDaemon ?? defaultSpawnDaemon;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const pollIntervalMs = opts.pairingPollIntervalMs ?? DEFAULT_PAIRING_POLL_INTERVAL_MS;
  const errorFile = opts.errorFile ?? defaultErrorFilePath();
  const postSpawnGraceMs = opts.postSpawnGraceMs ?? DEFAULT_POST_SPAWN_GRACE_MS;
  const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const existing = readConfig();
  const hubUrl = resolveHubUrl(opts, existing);
  if (!hubUrl) {
    const message = "no hub URL configured -- pass --hub <url> or set MANDO_HUB";
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  const machineName = existing?.machineName ?? hostname();
  let token = existing?.token;

  if (!token) {
    let pairing: PairingRequestResponse;
    try {
      pairing = await requestPairing(fetchFn, hubUrl, machineName);
    } catch (error) {
      const message = `pairing request failed: ${error instanceof Error ? error.message : String(error)}`;
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }

    const deepLink = `${hubUrl}/pair?code=${pairing.code}`;
    printResult(
      opts.json,
      { status: "pairing", code: pairing.code, deepLink, uiUrl: hubUrl },
      `Pairing code: ${pairing.code}\nApprove this machine at: ${deepLink}\nWaiting for approval...`,
    );

    const outcome = await pollUntilApproved(fetchFn, hubUrl, pairing.code, pairing.expiresAt, pollIntervalMs);
    if (outcome.status === "approved_without_token") {
      const message = "pairing was approved but the token was not received; re-run mando connect to try again";
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }
    if (outcome.status === "expired") {
      const message = "pairing code expired before it was approved";
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }

    token = outcome.token;
    writeConfig({ hubUrl, token, machineName });
  }

  const existingPid = readPidFile(defaultPidFilePath());
  if (existingPid !== null && isProcessAlive(existingPid)) {
    printResult(
      opts.json,
      { status: "connected", machine: machineName, uiUrl: hubUrl, alreadyRunning: true },
      `Already connected as "${machineName}". Manage this machine at ${hubUrl}`,
    );
    return { status: "connected", machine: machineName, uiUrl: hubUrl, alreadyRunning: true };
  }

  let opencodePort = opts.opencodePort ?? (await detectOpencodePort());
  if (!opencodePort) {
    // Without --opencode-auto, no local server is a hard stop -- connect()
    // has always required the user to already have one running (or to pass
    // --opencode-port explicitly). --opencode-auto opts into a different
    // contract: start one ourselves (see ensureOpencodeServer in
    // opencode.ts) rather than making every `mando connect` user keep a
    // second `opencode serve` terminal open.
    if (!opts.opencodeAuto) {
      const message = "could not detect a local opencode server -- pass --opencode-port <port>";
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }

    try {
      opencodePort = await ensureOpencodeServer(process.cwd());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }
  }

  // Cleared here (synchronously, before the child even exists) rather than
  // relying solely on the daemon's own startup clear (runDaemon does this
  // too) -- belt-and-suspenders against a stale error file from a previous
  // run being misread as this run's failure by the check below.
  clearLastError(errorFile);

  let daemonPid: number;
  try {
    daemonPid = spawnDaemon(opencodePort, process.cwd());
  } catch (error) {
    // Compiled installs where re-exec'ing the current executable itself
    // fails (e.g. permissions, a missing execPath) must not be reported as
    // "Connected" -- there is no daemon and never was one.
    const message = `failed to start daemon: ${error instanceof Error ? error.message : String(error)}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  // A fatal hub rejection (version_mismatch, unauthorized, hello_timeout)
  // happens immediately after the daemon's WS handshake -- well inside
  // this grace window -- so give it a brief chance to write errorFile (see
  // daemon.ts's runDaemon) before reporting "connected". The daemon runs
  // fully detached with stdio discarded, so this file is the only channel
  // available for a foreground `mando connect` to observe a same-tick-fast
  // failure; a real successful registration takes at least this long
  // anyway (network round trip + DB token lookup), so this adds no
  // perceptible delay to the common case.
  await sleepFn(postSpawnGraceMs);
  const fatal = readLastError(errorFile);
  if (fatal) {
    const message = `daemon failed to connect: ${fatal.message}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  // Belt-and-suspenders for failures the error-file channel above can't
  // see at all -- e.g. the compiled binary's re-exec'd `_daemon` child
  // dying before it ever gets far enough to open a socket (a missing
  // token, a bad argv, `process.execPath` resolving to something that
  // isn't actually this same binary). Without this, such a dead-on-arrival
  // daemon left connect() with no fatal error recorded and nothing to
  // report but a false "Connected" -- see the module-level bug this task
  // fixes.
  if (!isProcessAlive(daemonPid)) {
    const message = "daemon process is not running after spawn -- check that the mando binary can re-execute itself (`_daemon`)";
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  printResult(
    opts.json,
    { status: "connected", machine: machineName, uiUrl: hubUrl },
    `Connected as "${machineName}". Manage this machine at ${hubUrl}`,
  );

  return { status: "connected", machine: machineName, uiUrl: hubUrl };
}

export { printResult };

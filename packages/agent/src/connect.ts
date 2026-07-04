import { hostname } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig, type AgentConfig } from "./config";
import { detectOpencodePort as defaultDetectOpencodePort } from "./opencode";
import { defaultPidFilePath, isProcessAlive as defaultIsProcessAlive, readPidFile, writePidFile } from "./daemon";

export interface ConnectOpts {
  json?: boolean;
  // Accepted per the task brief's required opts shape and parsed by
  // index.ts's `--opencode-auto` flag, but not yet load-bearing here: the
  // brief's own step-3 algorithm is unconditional --
  // `opts.opencodePort ?? detectOpencodePort()` -- with no branch on this
  // flag. Reserved for a future task (e.g. gating whether to prompt before
  // auto-detecting) rather than given invented behavior now.
  opencodeAuto?: boolean;
  opencodePort?: number;
  args?: string[];
  // Not in the brief's minimal shape, but a natural home for the `--hub`
  // flag / MANDO_HUB env override index.ts's CLI parser extracts -- kept
  // here (rather than parsed a second time inside connect()) so opts stays
  // the single source of truth for everything the CLI layer already knew.
  hub?: string;
  // Test-only injection points (see task-3.4-report.md "How the daemon
  // spawn is tested"). None of these change connect()'s documented
  // behavior; they only let tests swap the real network/process calls for
  // deterministic stand-ins.
  pairingPollIntervalMs?: number;
  fetchFn?: typeof fetch;
  detectOpencodePort?: () => Promise<number | null>;
  spawnDaemon?: (opencodePort: number) => number;
  // Swaps out the real POSIX liveness check (daemon.ts's `isProcessAlive`,
  // itself `process.kill(pid, 0)` in a try/catch) used by the
  // already-running-daemon guard below, so tests can simulate a live or
  // dead pid without depending on real OS process ids.
  isProcessAlive?: (pid: number) => boolean;
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

// Spawns the detached daemon child (see daemon.ts) that owns the actual WS
// connection/forward loop for the rest of this "session". Per Bun's own
// docs, `detached: true` alone does not let the parent exit before the
// child -- `stdio: ["ignore","ignore","ignore"]` (so no inherited pipe
// keeps the parent alive waiting to drain it) AND calling `proc.unref()`
// are both required; see the SpawnOptions.detached doc comment in
// bun-types (node_modules/.../bun-types/bun.d.ts).
//
// The pidfile is written here, synchronously, using `proc.pid` -- not
// deferred to the child writing its own pidfile once its event loop gets
// around to it -- so that by the time connect() returns and prints
// "connected", `disconnect()`/`status()` can already find it. daemon.ts's
// own runDaemon() also writes the same pidfile at startup (see its
// module comment); since the child is spawned directly as `bun
// daemon.ts` with no intermediate shell, `proc.pid` and the daemon's own
// `process.pid` are the same process, so this is a redundant-but-harmless
// overwrite with an identical value, not a race.
function defaultSpawnDaemon(opencodePort: number): number {
  const daemonPath = join(import.meta.dir, "daemon.ts");
  const proc = Bun.spawn(["bun", daemonPath, "--opencode-port", String(opencodePort)], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    // Bun.spawn's `env` defaults to a snapshot of process.env taken when
    // *this* bun process launched -- runtime mutations (e.g. MANDO_CONFIG/
    // MANDO_PID_FILE overrides set by a caller or a test) are invisible to
    // that default. Passing process.env explicitly here means the child
    // always sees the current env, including MANDO_HUB/MANDO_CONFIG/
    // MANDO_PID_FILE/MANDO_OPENCODE_PASSWORD overrides.
    env: process.env,
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
  const spawnDaemon = opts.spawnDaemon ?? defaultSpawnDaemon;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const pollIntervalMs = opts.pairingPollIntervalMs ?? DEFAULT_PAIRING_POLL_INTERVAL_MS;

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

  const opencodePort = opts.opencodePort ?? (await detectOpencodePort());
  if (!opencodePort) {
    const message = "could not detect a local opencode server -- pass --opencode-port <port>";
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  spawnDaemon(opencodePort);

  printResult(
    opts.json,
    { status: "connected", machine: machineName, uiUrl: hubUrl },
    `Connected as "${machineName}". Manage this machine at ${hubUrl}`,
  );

  return { status: "connected", machine: machineName, uiUrl: hubUrl };
}

export { printResult };

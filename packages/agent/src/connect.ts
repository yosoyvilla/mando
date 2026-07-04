import { hostname } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig, type AgentConfig } from "./config";
import { detectOpencodePort as defaultDetectOpencodePort } from "./opencode";
import { defaultPidFilePath, writePidFile } from "./daemon";

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
}

export type ConnectResult =
  | { status: "connected"; machine: string; uiUrl: string }
  | { status: "error"; message: string };

type PairingRequestResponse = { code: string; expiresAt: string };
type PairingStatusResponse = { status: "pending" | "approved"; token?: string };

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
// which case the freshly-minted machine token is returned) or its
// expiresAt deadline passes (in which case this returns null). A non-2xx,
// non-410 response (a transient network/hub hiccup) is treated as "still
// pending" rather than a hard failure -- one bad poll shouldn't abort an
// otherwise-successful pairing the user is about to approve in the
// browser.
async function pollUntilApproved(
  fetchFn: typeof fetch,
  hubUrl: string,
  code: string,
  expiresAt: string,
  pollIntervalMs: number,
): Promise<string | null> {
  const deadline = new Date(expiresAt).getTime();

  while (Date.now() < deadline) {
    const res = await fetchFn(`${hubUrl}/api/v1/pairing/status?code=${encodeURIComponent(code)}`);
    if (res.status === 410) return null; // expired -- no point continuing to poll.
    if (res.ok) {
      const body = (await res.json()) as PairingStatusResponse;
      if (body.status === "approved" && body.token) return body.token;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return null;
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
export async function connect(opts: ConnectOpts = {}): Promise<ConnectResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const detectOpencodePort = opts.detectOpencodePort ?? defaultDetectOpencodePort;
  const spawnDaemon = opts.spawnDaemon ?? defaultSpawnDaemon;
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

    const approvedToken = await pollUntilApproved(fetchFn, hubUrl, pairing.code, pairing.expiresAt, pollIntervalMs);
    if (!approvedToken) {
      const message = "pairing code expired before it was approved";
      printResult(opts.json, { status: "error", message }, `Error: ${message}`);
      return { status: "error", message };
    }

    token = approvedToken;
    writeConfig({ hubUrl, token, machineName });
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

import { createServer } from "node:net";

// Ports opencode's local HTTP server has been observed to listen on when
// no explicit override is configured. 4096 is opencode's documented
// default; 4097 is kept as a narrow fallback in case 4096 is already in
// use on the machine (e.g. another local service).
const DEFAULT_CANDIDATE_PORTS = [4096, 4097];

// Per-probe timeout so a firewalled/black-holed port can't stall detection
// (candidate probing awaits each port in turn).
const PROBE_TIMEOUT_MS = 1000;

// checkHealth probes `GET /doc` on `port`. "Healthy" here means the server
// answered at all -- any HTTP response (2xx, 404, whatever) proves a real
// HTTP server is listening, which is all detection needs. A thrown fetch
// error (connection refused, timeout, DNS failure) means nothing is there.
export async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/doc`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    // Drain/release the connection immediately -- this probe never reads
    // the body, and callers (e.g. reconnect polling) may call checkHealth
    // often, so leaving responses unconsumed would leak sockets over time.
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// detectOpencodePort finds the local opencode server's port.
//
// Policy (documented per task brief): if MANDO_OPENCODE_PORT is set, it is
// tried FIRST and verified with checkHealth before being trusted -- an
// operator-supplied override is still just a hint, and blindly trusting an
// unverified/stale value risks silently pointing the tunnel at the wrong
// service (or nothing). If the override doesn't answer, detection falls
// back to probing the default candidate list rather than giving up, since
// a bad override shouldn't prevent detection from finding the real port.
// If nothing answers -- override or candidates -- this returns null.
export async function detectOpencodePort(): Promise<number | null> {
  const override = process.env.MANDO_OPENCODE_PORT;
  if (override) {
    const port = Number(override);
    if (Number.isInteger(port) && port > 0 && (await checkHealth(port))) {
      return port;
    }
  }

  for (const port of DEFAULT_CANDIDATE_PORTS) {
    if (await checkHealth(port)) {
      return port;
    }
  }

  return null;
}

// Overall time budget for ensureOpencodeServer to see a freshly spawned
// `opencode serve` answer /doc before giving up -- generous enough for a
// cold start (binary load, config parse) without letting `mando connect
// --opencode-auto` hang indefinitely on a broken install.
const ENSURE_SERVER_DEADLINE_MS = 30_000;

// How often ensureOpencodeServer re-probes /doc while waiting for a freshly
// spawned server to come up.
const ENSURE_SERVER_POLL_INTERVAL_MS = 200;

// Grabs an ephemeral port from the OS and releases it immediately, so a
// concrete port number can be handed to `opencode serve --port` up front
// instead of scraping a chosen port out of its log output. Mirrors
// e2e/fixtures/real-opencode.ts's reserveFreePort -- same bind-then-close
// pattern, same tiny (harmless, single-machine) bind-again race.
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ensureOpencodeServer finds or starts a local opencode server for
// `directory`, returning the port it can be reached on. This is what
// `mando connect --opencode-auto` (see connect.ts) falls back to when
// detectOpencodePort() finds nothing, so the user never has to open a
// second terminal and run `opencode serve` themselves.
//
// Detection first, via the exact same override + candidate-port logic used
// everywhere else in this module: if a server is already up, reuse it
// rather than spawning a redundant second one. Only spawns a new `opencode
// serve` when nothing answers.
//
// The spawned process is detached and unref'd because it must outlive this
// call -- connect() returns and exits shortly after, but the daemon it
// spawns right after this needs the opencode server to keep serving for
// the rest of the session.
export async function ensureOpencodeServer(directory: string): Promise<number> {
  const existing = await detectOpencodePort();
  if (existing) return existing;

  const port = await reserveFreePort();
  const bin = process.env.MANDO_OPENCODE_BIN ?? "opencode";

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: directory,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: { ...process.env },
    });
  } catch (error) {
    // Bun.spawn resolves the binary from PATH itself before forking, so a
    // missing/misconfigured MANDO_OPENCODE_BIN (or no `opencode` on PATH at
    // all) throws synchronously here rather than surfacing later as a
    // dead child -- catch it now and give a clear, actionable message
    // instead of letting an ENOENT/"Executable not found" error escape
    // connect() verbatim.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not start opencode serve -- is opencode installed? (${detail})`);
  }
  proc.unref();

  const deadline = Date.now() + ENSURE_SERVER_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await checkHealth(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, ENSURE_SERVER_POLL_INTERVAL_MS));
  }

  try {
    proc.kill();
  } catch {
    // Already exited -- fine, nothing left to clean up.
  }
  throw new Error("could not start opencode serve -- is opencode installed?");
}

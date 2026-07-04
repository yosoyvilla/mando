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

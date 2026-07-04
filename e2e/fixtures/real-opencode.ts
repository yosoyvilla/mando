// Boots a REAL `opencode serve` (v1.17.13) as a child process -- the
// counterpart to fixtures/stub-opencode.ts, used only by the gated
// real-opencode handoff test (global-setup-real.ts + tests/
// real-opencode-handoff.spec.ts). The point of that test is to prove the
// hub -> agent -> opencode path works against the actual opencode server,
// not a fake we wrote ourselves, so nothing here reimplements opencode's
// behavior -- it just launches the binary and exposes a couple of helpers
// for talking to it directly (simulating the "terminal" client that starts
// a session before the phone connects).
//
// Node-safe (node:child_process/node:net/global fetch): this module is
// imported by global-setup-real.ts, which Playwright runs under Node even
// under `bunx playwright test` (same "Node vs Bun" note as
// global-setup.ts). `opencode serve` itself is a self-contained binary, so
// spawning it via child_process is runtime-agnostic.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor, waitForExit } from "./proc-utils";

// Fixed path the gated global-setup writes its handoff state to and the
// gated spec reads it back from. Playwright's globalSetup runs in a
// different process than the test workers and env vars set there do not
// reliably reach workers, so the two sides rendezvous through this file
// instead. Kept in tmpdir (not the repo) so it never needs gitignoring.
export const REAL_HANDOFF_STATE_FILE = join(tmpdir(), "mando-real-opencode-handoff.json");

export interface RealHandoffState {
  hubBaseUrl: string;
  machineId: string;
  // The hub-issued machine name, so the browser handoff test can select
  // this exact machine in the UI's machine picker (rather than relying
  // solely on the app's auto-select-first-online heuristic).
  machineName: string;
  opencodePort: number;
  // A session created by talking to opencode DIRECTLY (the "terminal"
  // client), before the machine came online -- the thing the handoff test
  // must find again through the hub proxy.
  terminalSessionId: string;
}

export interface RealOpencode {
  port: number;
  // Creates a session by calling the real opencode API directly (not
  // through the hub) -- simulates a different client (a terminal) starting
  // a session. Returns the id opencode assigned.
  createSession(): Promise<string>;
  stop(): Promise<void>;
}

// Grabs an ephemeral port from the OS and releases it, so we can hand a
// concrete port to `opencode serve --port`. opencode does support
// `--port 0`, but then we'd have to scrape the chosen port out of its log
// lines; reserving one up front and passing it in is simpler and the
// tiny bind/close race is harmless in a single-machine test harness.
async function reserveFreePort(): Promise<number> {
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

// Starts a real opencode server and waits until `GET /doc` answers 200
// (opencode's OpenAPI doc endpoint -- the same signal the agent's own
// checkHealth uses). The binary is `opencode` on PATH by default,
// overridable via MANDO_OPENCODE_BIN. Runs in an isolated temp CWD so the
// sessions it reports come from a clean location rather than the repo.
export async function startRealOpencode(): Promise<RealOpencode> {
  const port = await reserveFreePort();
  const bin = process.env.MANDO_OPENCODE_BIN ?? "opencode";
  const cwd = mkdtempSync(join(tmpdir(), "mando-real-oc-"));

  const proc: ChildProcess = spawn(
    bin,
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  // Capture opencode's own stdout/stderr (bounded tail). With stdio:inherit
  // a hung/crashed `serve` in CI just times out on /doc with no explanation;
  // echoing the output and folding its tail into the timeout error makes the
  // real cause visible in the CI log instead of a bare "timed out".
  let ocOutput = "";
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);
    ocOutput = (ocOutput + text).slice(-4000);
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);

  let spawnError: Error | null = null;
  proc.once("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });

  try {
    // 120s (not 30s): a cold CI runner's first `opencode serve` is far slower
    // to bind /doc than a warm local machine's.
    //
    // The per-request AbortSignal.timeout is load-bearing, not decoration:
    // opencode has been observed to bind its port ("listening") while /doc
    // stalls the connection for minutes. Node's fetch has no default timeout,
    // and waitFor only re-checks its deadline BETWEEN iterations -- so a
    // single hung probe blocks past the 120s budget entirely (a real CI run
    // failed 5 minutes after "listening"). Bounding each probe to 5s makes a
    // stalled connection abort and lets waitFor poll again within its
    // deadline. This mirrors the agent's own checkHealth (see
    // packages/agent/src/opencode.ts), which guards its /doc probe the same
    // way. Body is drained so repeated probes don't leak sockets.
    await waitFor(
      async () => {
        if (spawnError) throw spawnError;
        const res = await fetch(`http://127.0.0.1:${port}/doc`, { signal: AbortSignal.timeout(5_000) });
        await res.body?.cancel();
        return res.ok;
      },
      120_000,
      `real opencode (${bin}) GET /doc on port ${port}`,
    );
  } catch (error) {
    proc.kill("SIGTERM");
    await waitForExit(proc).catch(() => {});
    const base = error instanceof Error ? error.message : String(error);
    const detail = ocOutput.trim()
      ? `\n--- opencode output (tail) ---\n${ocOutput.trim()}`
      : " (opencode produced no output before the timeout)";
    throw new Error(`${base}${detail}`);
  }

  return {
    port,
    async createSession() {
      const res = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        throw new Error(`real opencode POST /api/session failed with status ${res.status}`);
      }
      const body = (await res.json()) as { data: { id: string } };
      if (!body.data?.id) throw new Error("real opencode POST /api/session returned no session id");
      return body.data.id;
    },
    async stop() {
      proc.kill("SIGTERM");
      await waitForExit(proc).catch(() => {});
    },
  };
}

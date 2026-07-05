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
// The "terminal" session is created via a real `opencode run <message>`
// (verified against a live opencode 1.17.13), not `POST /api/session` --
// that's the entire point of this harness: `/api/*`-created sessions have
// always been visible to Mando, but a plain-TUI/`run` session (writing the
// `message` store the UNPREFIXED family serves) is the actual production
// bug this suite guards against. `opencode run` writes its session to the
// same on-disk project store `opencode serve` reads from when both share a
// directory -- there is no in-memory state tied to the specific server
// process -- so running it with `cwd` set to the same directory the serve
// process was started in is what makes the session discoverable via that
// server's `GET /session?directory=<dir>` afterward.
//
// Node-safe (node:child_process/node:net/global fetch): this module is
// imported by global-setup-real.ts, which Playwright runs under Node even
// under `bunx playwright test` (same "Node vs Bun" note as
// global-setup.ts). `opencode` itself is a self-contained binary, so
// spawning it via child_process is runtime-agnostic.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync } from "node:fs";
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
  // The real opencode server's cwd -- also the connect directory the
  // seeded machine reports (see global-setup-real.ts's bringMachineOnline)
  // and the `?directory=` value the web UI/specs scope the session list to.
  // Always the resolved realpath (see startRealOpencode below): on macOS
  // `/tmp` is itself a symlink to `/private/tmp`, and opencode records a
  // session's `directory` as the resolved path, so an unresolved tmpdir()
  // value would never match a `?directory=` filter.
  directory: string;
  // A session created by talking to opencode DIRECTLY via `opencode run`
  // (the "terminal" client), before the machine came online -- the thing
  // the handoff test must find again through the hub proxy.
  terminalSessionId: string;
  // The exact text sent as the terminal's message -- specs assert this
  // comes back through `GET /session/:id/message` via the proxy, which is
  // the exact production bug this suite guards against (session visible,
  // messages empty).
  terminalMessageText: string;
}

// Bare `{info, parts}` shape opencode's UNPREFIXED `GET
// /session/:id/message` returns (confirmed against a live opencode
// 1.17.13) -- loosely typed since specs only ever read `info.role` and join
// `parts` text, the same defensive narrowing use-session-messages.ts's
// `normalizeFetchedMessages` does on the web side.
export interface OpencodeMessageEntry {
  info: { id: string; role: string; sessionID?: string };
  parts: Array<{ type: string; text?: string }>;
}

export function opencodeMessageText(entry: OpencodeMessageEntry): string {
  return entry.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export interface RealOpencode {
  port: number;
  // The resolved directory the server runs in -- see RealHandoffState's
  // `directory` doc comment above.
  directory: string;
  // Creates a session the way a REAL terminal user does: `opencode run
  // <message>` in the same directory the server is scoped to. CI has no
  // provider key configured, so the run's model call is expected to fail
  // (nonzero exit) -- that's fine, the session and its user message are
  // persisted before/regardless of the provider call (verified in
  // production debugging: a provider-401 session still stored its user
  // message). Returns the id opencode assigned once the session is
  // discoverable via `GET /session?directory=<directory>`.
  createTerminalSession(message: string): Promise<string>;
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
  // Resolved via realpath -- see RealHandoffState's `directory` doc comment
  // above for why (macOS `/tmp` is a symlink; opencode records the
  // resolved path, so an unresolved tmpdir() value would never match a
  // later `?directory=` filter).
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "mando-real-oc-")));

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
    directory: cwd,
    async createTerminalSession(message: string) {
      const runProc: ChildProcess = spawn(bin, ["run", message], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let runOutput = "";
      const captureRun = (chunk: Buffer) => {
        runOutput = (runOutput + chunk.toString()).slice(-4000);
      };
      runProc.stdout?.on("data", captureRun);
      runProc.stderr?.on("data", captureRun);

      // `opencode run` needs a model; CI has no provider key configured, so
      // the run's model call is expected to fail (nonzero exit) -- that is
      // FINE, the session and its user message are persisted before/
      // regardless of the provider call (see this file's module comment
      // and RealOpencode's `createTerminalSession` doc comment). Bounded so
      // a genuinely stuck run (e.g. something waiting on a TTY that isn't
      // there) cannot hang the harness: it is killed and treated the same
      // as a fast provider failure, since the session should already exist
      // by the time any model call would even start.
      const RUN_TIMEOUT_MS = 30_000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          runProc.kill("SIGTERM");
        }, RUN_TIMEOUT_MS);
        runProc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        runProc.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      const directoryParam = encodeURIComponent(cwd);
      let sessionId: string | null = null;
      try {
        await waitFor(
          async () => {
            const res = await fetch(`http://127.0.0.1:${port}/session?directory=${directoryParam}`);
            if (!res.ok) return false;
            const list = (await res.json()) as Array<{ id: string; time: { created: number } }>;
            if (list.length === 0) return false;
            sessionId = list.reduce((newest, s) => (s.time.created > newest.time.created ? s : newest)).id;
            return true;
          },
          20_000,
          `real opencode session for directory ${cwd} to appear after "opencode run"`,
        );
      } catch (error) {
        const base = error instanceof Error ? error.message : String(error);
        const detail = runOutput.trim()
          ? `\n--- opencode run output (tail) ---\n${runOutput.trim()}`
          : " (opencode run produced no output before the timeout)";
        throw new Error(`${base}${detail}`);
      }

      if (!sessionId) throw new Error("real opencode run produced no discoverable session id");
      return sessionId;
    },
    async stop() {
      proc.kill("SIGTERM");
      await waitForExit(proc).catch(() => {});
    },
  };
}

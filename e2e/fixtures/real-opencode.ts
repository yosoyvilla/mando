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
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
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
  // A session created by talking to opencode DIRECTLY (the "terminal"
  // client), before the machine came online -- the thing the handoff test
  // must find again through the hub proxy.
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
  // Creates a session in the TERMINAL-VISIBLE store (the `message` table
  // the unprefixed API family reads -- the exact store a plain-TUI user's
  // sessions live in) and persists one user message into it, without any
  // model/provider involvement: `POST /session?directory=` + `POST
  // /session/:id/message {noReply:true}` (both verified against a live
  // opencode 1.17.13; `directory` MUST be a query param -- a body field is
  // silently ignored and the session lands in the serve cwd's project).
  //
  // Deliberately NOT `opencode run <message>`: with any ambient provider
  // credentials (env/keychain) that spawns a real autonomous agent -- in a
  // local run it started reading the repo and burning provider credits --
  // and with none it exits nonzero on a timing-dependent path. The
  // noReply flow writes to the same store deterministically. (That
  // `opencode run` sessions land in this store was verified manually in
  // production debugging: a live TUI session served 30 messages through
  // this same endpoint.)
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

  // Hermetic HOME: both `serve` and `run` below get a fresh HOME inside the
  // temp dir instead of the developer's real one. Ambient opencode config
  // (~/.config/opencode plugins, custom agents) otherwise leaks into the
  // harness -- observed locally: a plugin-heavy user config made
  // `opencode run` hang past its kill timeout, so the terminal session never
  // appeared. CI runners have a near-empty HOME, which is exactly the
  // environment this recreates; the two processes still share one store
  // because they share this HOME.
  const home = join(cwd, "home");
  mkdirSync(home, { recursive: true });
  const hermeticEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };

  const proc: ChildProcess = spawn(
    bin,
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd, stdio: ["ignore", "pipe", "pipe"], env: hermeticEnv },
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
      // See the RealOpencode doc comment for why this is HTTP + noReply
      // rather than `opencode run`.
      const directoryParam = encodeURIComponent(cwd);
      const createRes = await fetch(`http://127.0.0.1:${port}/session?directory=${directoryParam}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!createRes.ok) {
        throw new Error(`real opencode POST /session?directory= failed with status ${createRes.status}`);
      }
      const created = (await createRes.json()) as { id?: string; directory?: string };
      if (!created.id) throw new Error("real opencode POST /session returned no session id");
      if (created.directory !== cwd) {
        throw new Error(
          `real opencode created the session in "${created.directory}" instead of "${cwd}" -- ` +
            "the ?directory= query param contract changed",
        );
      }

      const messageRes = await fetch(`http://127.0.0.1:${port}/session/${created.id}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: message }] }),
      });
      if (!messageRes.ok) {
        throw new Error(
          `real opencode POST /session/:id/message (noReply) failed with status ${messageRes.status}`,
        );
      }

      // Read-back guard: the message must be servable through the same
      // unprefixed endpoint the web uses -- this is the exact production
      // bug the suite exists to catch (session visible, messages empty).
      const readBack = await fetch(`http://127.0.0.1:${port}/session/${created.id}/message`);
      const entries = (await readBack.json()) as OpencodeMessageEntry[];
      if (!entries.some((entry) => opencodeMessageText(entry).includes(message))) {
        throw new Error("terminal message did not read back through GET /session/:id/message");
      }

      return created.id;
    },
    async stop() {
      proc.kill("SIGTERM");
      await waitForExit(proc).catch(() => {});
    },
  };
}

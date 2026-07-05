import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves the actual bug this task fixes: a `bun build --compile` binary's
// hidden `_daemon` subcommand (see index.ts's dispatch) runs the daemon
// loop in-process (daemon.ts's runDaemonMain), instead of connect.ts's
// old defaultSpawnDaemon trying -- and instantly failing -- to hand `bun`
// a `daemon.ts` file that does not exist on disk inside the compiled
// binary (import.meta.dir there is a virtual `/$bunfs/...` path). Building
// the real binary is slow (an actual `bun build --compile`, ~10-30s) but
// is the only way to exercise that `/$bunfs/...` behavior for real; the
// plain unit tests in test/unit/connect.test.ts cover connect()'s
// dead-daemon detection without paying this cost on every run.
//
// The hub at 127.0.0.1:1 in the config below is deliberately unreachable
// -- this test only asserts the compiled entrypoint dispatches `_daemon`
// and gets far enough to write its pidfile (runDaemon's very first action,
// before it even attempts the WS handshake -- see daemon.ts), not that it
// ever successfully registers with a hub.

let workDir: string | null = null;
let daemonProc: ReturnType<typeof Bun.spawn> | null = null;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// A port number to hand the daemon as `--opencode-port` -- the daemon
// never binds to this itself (it's only used as a forwarding target and
// for local-opencode health checks, both of which this test never
// exercises since the hub is unreachable), so an arbitrary unused-looking
// high port is fine; no need to actually reserve one.
const FAKE_OPENCODE_PORT = 59998;

afterEach(() => {
  if (daemonProc?.pid && isAlive(daemonProc.pid)) {
    try {
      daemonProc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  daemonProc = null;

  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

describe("compiled binary's hidden _daemon subcommand", () => {
  it(
    "starts the daemon loop and writes its pidfile when run from the actual compiled binary",
    async () => {
      workDir = mkdtempSync(join(tmpdir(), "mando-compiled-binary-test-"));
      const outfile = join(workDir, "mando-test");

      // Absolute paths throughout (build.ts, outfile) so this build works
      // the same regardless of this test process's own cwd.
      const buildScript = join(import.meta.dir, "..", "build.ts");
      const build = Bun.spawnSync(["bun", "run", buildScript, `--outfile=${outfile}`], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      expect(build.exitCode).toBe(0);
      expect(existsSync(outfile)).toBe(true);

      const configFile = join(workDir, "config.json");
      writeFileSync(
        configFile,
        JSON.stringify({ hubUrl: "http://127.0.0.1:1", token: "x.y", machineName: "t" }),
        "utf-8",
      );
      const pidFile = join(workDir, "pid");

      daemonProc = Bun.spawn([outfile, "_daemon", "--opencode-port", String(FAKE_OPENCODE_PORT)], {
        env: {
          ...process.env,
          MANDO_CONFIG: configFile,
          MANDO_PID_FILE: pidFile,
          MANDO_STATE_FILE: join(workDir, "state.json"),
          MANDO_ERROR_FILE: join(workDir, "error.json"),
        },
        stdio: ["ignore", "ignore", "ignore"],
      });

      await waitFor(() => existsSync(pidFile), 10_000);

      expect(existsSync(pidFile)).toBe(true);
      expect(daemonProc.pid).toBeGreaterThan(0);
      expect(isAlive(daemonProc.pid)).toBe(true);
    },
    60_000,
  );
});

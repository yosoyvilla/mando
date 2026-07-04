import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnect, status } from "../../src/index";
import { writeLastSeen, writePidFile } from "../../src/daemon";

let tmpDir: string | null = null;
let pidFile: string | null = null;
let stateFile: string | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mando-index-test-"));
  pidFile = join(tmpDir, "pid");
  stateFile = join(tmpDir, "state.json");
  process.env.MANDO_PID_FILE = pidFile;
  process.env.MANDO_STATE_FILE = stateFile;
});

afterEach(() => {
  child?.kill();
  child = null;
  delete process.env.MANDO_PID_FILE;
  delete process.env.MANDO_STATE_FILE;
  delete process.env.MANDO_CONFIG;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  pidFile = null;
  stateFile = null;
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("disconnect", () => {
  it("kills the process recorded in the pidfile and removes the pidfile", async () => {
    child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    writePidFile(pidFile!, child.pid);

    const result = disconnect();
    expect(result).toEqual({ status: "disconnected" });
    expect(existsSync(pidFile!)).toBe(false);

    // Give the OS a moment to actually deliver SIGTERM.
    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(child.pid)).toBe(false);
  });

  it("reports not_running and cleans up a stale pidfile pointing at a dead process", () => {
    // A pid that is extremely unlikely to be alive: spawn and let it exit.
    const dead = Bun.spawnSync(["true"]);
    writePidFile(pidFile!, dead.pid ?? 999999);

    const result = disconnect();
    expect(result).toEqual({ status: "not_running" });
    expect(existsSync(pidFile!)).toBe(false);
  });

  it("reports not_running when there is no pidfile at all", () => {
    const result = disconnect();
    expect(result).toEqual({ status: "not_running" });
  });
});

describe("status", () => {
  it("reports unconfigured when there is no config file", () => {
    process.env.MANDO_CONFIG = join(tmpDir!, "no-such-config.json");
    const result = status();
    expect(result.configured).toBe(false);
    expect(result.daemonRunning).toBe(false);
  });

  it("reports the daemon as running when the pidfile points at a live process", () => {
    // Point at a config path that doesn't exist -- this test only cares
    // about pidfile-derived fields, and must not depend on (or read) a
    // real ~/.mando.json that happens to exist on the machine running it.
    process.env.MANDO_CONFIG = join(tmpDir!, "no-such-config.json");
    child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    writePidFile(pidFile!, child.pid);

    const result = status();
    expect(result.daemonRunning).toBe(true);
    expect(result.pid).toBe(child.pid);
  });

  it("surfaces lastSeenAt from the daemon's state file", () => {
    process.env.MANDO_CONFIG = join(tmpDir!, "no-such-config.json");
    writeLastSeen(stateFile!, new Date("2026-01-01T00:00:00.000Z"));

    const result = status();
    expect(result.lastSeenAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reports lastSeenAt as undefined when no state file exists yet", () => {
    process.env.MANDO_CONFIG = join(tmpDir!, "no-such-config.json");

    const result = status();
    expect(result.lastSeenAt).toBeUndefined();
  });
});

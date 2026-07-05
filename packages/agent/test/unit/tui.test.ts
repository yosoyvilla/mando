import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTui } from "../../src/tui";
import { writeConfig } from "../../src/config";
import { checkHealth } from "../../src/opencode";

// A fake `opencode` binary that understands the two subcommands runTui/
// ensureOpencodeServer actually invoke it with:
//
//   serve --port <n> --hostname 127.0.0.1   -- answers GET /doc like a real
//     opencode server would (see opencode.test.ts's own shim, same shape),
//     plus /__test_shutdown__ so tests can stop the detached process instead
//     of leaking it past the test run.
//   attach <url> --dir <dir>                -- records its full argv to
//     MANDO_TEST_ARGV_FILE (as JSON) so tests can assert exactly what
//     runTui() invoked it with, then exits after MANDO_TEST_EXIT_DELAY_MS
//     with code MANDO_TEST_EXIT_CODE (both default to 0) -- this is what
//     lets tests assert exit-code propagation and exercise the SIGINT
//     window without a real opencode binary installed.
let shimDir: string;
let shimPath: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "mando-tui-fake-opencode-"));
  shimPath = join(shimDir, "opencode");
  writeFileSync(
    shimPath,
    [
      "#!/usr/bin/env bun",
      "const args = process.argv.slice(2);",
      'if (args[0] === "serve") {',
      '  const port = Number(args[args.indexOf("--port") + 1]);',
      "  Bun.serve({",
      "    port,",
      '    hostname: "127.0.0.1",',
      "    fetch(req) {",
      '      if (new URL(req.url).pathname === "/__test_shutdown__") {',
      "        setTimeout(() => process.exit(0), 10);",
      '        return new Response("ok");',
      "      }",
      '      return new Response("{}", { status: 200 });',
      "    },",
      "  });",
      '} else if (args[0] === "attach") {',
      "  const argvFile = process.env.MANDO_TEST_ARGV_FILE;",
      '  if (argvFile) require("node:fs").writeFileSync(argvFile, JSON.stringify(args), "utf-8");',
      '  const delay = Number(process.env.MANDO_TEST_EXIT_DELAY_MS ?? "0");',
      '  const code = Number(process.env.MANDO_TEST_EXIT_CODE ?? "0");',
      "  setTimeout(() => process.exit(code), delay);",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shimPath, 0o755);
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

let workDir: string;
let argvFile: string;
let originalConsoleError: typeof console.error;
let errors: string[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mando-tui-test-"));
  argvFile = join(workDir, "argv.json");
  process.env.MANDO_CONFIG = join(workDir, "config.json");
  process.env.MANDO_PID_FILE = join(workDir, "pid");
  process.env.MANDO_OPENCODE_BIN = shimPath;
  process.env.MANDO_TEST_ARGV_FILE = argvFile;
  errors = [];
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  delete process.env.MANDO_CONFIG;
  delete process.env.MANDO_PID_FILE;
  delete process.env.MANDO_OPENCODE_BIN;
  delete process.env.MANDO_OPENCODE_PORT;
  delete process.env.MANDO_TEST_ARGV_FILE;
  delete process.env.MANDO_TEST_EXIT_DELAY_MS;
  delete process.env.MANDO_TEST_EXIT_CODE;
  rmSync(workDir, { recursive: true, force: true });
});

function readArgv(): string[] {
  return JSON.parse(readFileSync(argvFile, "utf-8"));
}

// Reserves a real, currently-healthy "opencode server" for tests that need
// an explicit --opencode-port to succeed its health check without going
// through ensureOpencodeServer's detect-or-spawn path at all.
function startHealthyStub(): { server: ReturnType<typeof Bun.serve>; port: number } {
  const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
  if (typeof server.port !== "number") throw new Error("test server has no port");
  return { server, port: server.port };
}

describe("runTui", () => {
  it("reuses an already-healthy explicit --opencode-port and attaches without spawning a daemon (unpaired hint printed)", async () => {
    const { server, port } = startHealthyStub();
    try {
      const code = await runTui({ dir: workDir, opencodePort: port });
      expect(code).toBe(0);
      expect(readArgv()).toEqual(["attach", `http://127.0.0.1:${port}`, "--dir", workDir]);
      expect(errors.some((l) => l.includes("not paired with a hub"))).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("starts a new serve when none is detected, then attaches to the port it started", async () => {
    // No explicit --opencode-port and no MANDO_OPENCODE_PORT override --
    // runTui falls through to ensureOpencodeServer(dir), which itself
    // checks the default candidate ports (4096/4097) before spawning.
    // Skip (rather than fail) if something real is already listening
    // there, same defensive skip opencode.test.ts uses -- this
    // environment's ports aren't under the test's control.
    if ((await checkHealth(4096)) || (await checkHealth(4097))) return;

    const code = await runTui({ dir: shimDir });
    expect(code).toBe(0);

    const argv = readArgv();
    expect(argv[0]).toBe("attach");
    expect(argv[1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(argv.slice(2)).toEqual(["--dir", shimDir]);

    const port = Number(new URL(argv[1]).port);
    await fetch(`http://127.0.0.1:${port}/__test_shutdown__`).catch(() => {});
  }, 10_000);

  it("errors clearly and never attaches when the explicit --opencode-port is dead", async () => {
    const code = await runTui({ dir: workDir, opencodePort: 1 });
    expect(code).not.toBe(0);
    expect(errors.some((l) => l.includes("1"))).toBe(true);
    expect(() => readArgv()).toThrow();
  });

  it("spawns the daemon when a token is configured and no daemon is already alive", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", token: "tok", machineName: "m" });
    const { server, port } = startHealthyStub();
    const spawnCalls: Array<[number, string]> = [];

    try {
      const code = await runTui({
        dir: workDir,
        opencodePort: port,
        spawnDaemon: (p, d) => {
          spawnCalls.push([p, d]);
          return process.pid;
        },
      });

      expect(code).toBe(0);
      expect(spawnCalls).toEqual([[port, workDir]]);
      expect(errors.some((l) => l.includes("not paired"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("does not spawn a daemon when one is already alive", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", token: "tok", machineName: "m" });
    writeFileSync(process.env.MANDO_PID_FILE!, String(process.pid), "utf-8");
    const { server, port } = startHealthyStub();
    const spawnCalls: number[] = [];

    try {
      const code = await runTui({
        dir: workDir,
        opencodePort: port,
        spawnDaemon: (p) => {
          spawnCalls.push(p);
          return process.pid;
        },
      });

      expect(code).toBe(0);
      expect(spawnCalls).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  it("prints a one-line hint and still attaches when unpaired (no token configured)", async () => {
    const { server, port } = startHealthyStub();
    try {
      const code = await runTui({ dir: workDir, opencodePort: port });
      expect(code).toBe(0);
      const hint = errors.find((l) => l.includes("not paired with a hub"));
      expect(hint).toBeDefined();
      expect(hint).toContain("mando connect --hub");
      expect(readArgv()[0]).toBe("attach");
    } finally {
      server.stop(true);
    }
  });

  it("propagates the attached child's real exit code", async () => {
    process.env.MANDO_TEST_EXIT_CODE = "42";
    const { server, port } = startHealthyStub();
    try {
      const code = await runTui({ dir: workDir, opencodePort: port });
      expect(code).toBe(42);
    } finally {
      server.stop(true);
    }
  });

  it("ignores SIGINT while the attached child is running and still returns its real exit code", async () => {
    process.env.MANDO_TEST_EXIT_DELAY_MS = "150";
    process.env.MANDO_TEST_EXIT_CODE = "7";
    const { server, port } = startHealthyStub();
    const listenersBefore = process.listenerCount("SIGINT");

    try {
      const resultPromise = runTui({ dir: workDir, opencodePort: port });
      // Give the child a moment to spawn and register the file write before
      // the signal fires -- mirrors a real Ctrl+C landing on both processes
      // (mando and the attached child share a foreground process group)
      // partway through the attach session.
      await new Promise((resolve) => setTimeout(resolve, 40));
      process.kill(process.pid, "SIGINT");

      const code = await resultPromise;
      expect(code).toBe(7);
    } finally {
      server.stop(true);
    }

    // The no-op handler installed for the duration of the attach must be
    // removed once it resolves -- no dangling listener left behind.
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHealth, detectOpencodePort, ensureOpencodeServer } from "../../src/opencode";

let server: ReturnType<typeof Bun.serve> | null = null;
const originalOverride = process.env.MANDO_OPENCODE_PORT;
const originalBin = process.env.MANDO_OPENCODE_BIN;

// Bun's Server.port is typed `number | undefined` (unix-socket servers have
// no port). Every server in this suite binds a TCP port (0 = ephemeral), so
// this just asserts that expectation instead of scattering `!` everywhere.
function requirePort(s: ReturnType<typeof Bun.serve>): number {
  if (typeof s.port !== "number") throw new Error("test server has no port (expected a TCP listener)");
  return s.port;
}

afterEach(() => {
  server?.stop(true);
  server = null;
  if (originalOverride === undefined) {
    delete process.env.MANDO_OPENCODE_PORT;
  } else {
    process.env.MANDO_OPENCODE_PORT = originalOverride;
  }
  if (originalBin === undefined) {
    delete process.env.MANDO_OPENCODE_BIN;
  } else {
    process.env.MANDO_OPENCODE_BIN = originalBin;
  }
});

describe("checkHealth", () => {
  it("returns true when the port answers GET /doc", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
    expect(await checkHealth(requirePort(server))).toBe(true);
  });

  it("returns false when nothing is listening on the port", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = requirePort(s);
    s.stop(true);
    expect(await checkHealth(port)).toBe(false);
  });
});

describe("detectOpencodePort", () => {
  it("returns the MANDO_OPENCODE_PORT override when it answers /doc", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = requirePort(server);
    process.env.MANDO_OPENCODE_PORT = String(port);

    expect(await detectOpencodePort()).toBe(port);
  });

  it("falls back to the default candidate port 4096 when no override is set", async () => {
    delete process.env.MANDO_OPENCODE_PORT;

    let stub: ReturnType<typeof Bun.serve>;
    try {
      stub = Bun.serve({ port: 4096, fetch: () => new Response("ok") });
    } catch {
      // Port 4096 is already occupied in this environment (e.g. a real
      // opencode instance) -- skip rather than produce a false failure.
      return;
    }
    try {
      expect(await detectOpencodePort()).toBe(4096);
    } finally {
      stub.stop(true);
    }
  });

  it("returns null when neither the override nor any default candidate answers", async () => {
    process.env.MANDO_OPENCODE_PORT = "1"; // reserved port, guaranteed closed for a plain client connect

    const candidateBusy = (await checkHealth(4096)) || (await checkHealth(4097));
    if (candidateBusy) {
      // Something is genuinely listening on a default candidate port in
      // this environment; detectOpencodePort would legitimately return it,
      // so skip rather than assert a false failure.
      return;
    }

    expect(await detectOpencodePort()).toBeNull();
  });
});

// A fake `opencode` binary for ensureOpencodeServer's spawn path: a tiny Bun
// script (run via its own `#!/usr/bin/env bun` shebang, so MANDO_OPENCODE_BIN
// can point straight at the file with no PATH manipulation needed) that
// understands just enough of `serve --port <n>` to bind that port and answer
// `GET /doc` with 200 -- the same signal the real detectOpencodePort/
// checkHealth probe for. It also answers `/__test_shutdown__` so tests can
// ask the detached process to exit instead of leaking it past the test run
// (ensureOpencodeServer intentionally unrefs its child so it outlives the
// caller -- see opencode.ts -- so nothing else will ever stop it).
let shimDir: string;
let shimPath: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "mando-fake-opencode-"));
  shimPath = join(shimDir, "opencode");
  writeFileSync(
    shimPath,
    [
      "#!/usr/bin/env bun",
      'const args = process.argv.slice(2);',
      'const port = Number(args[args.indexOf("--port") + 1]);',
      "Bun.serve({",
      '  port,',
      '  hostname: "127.0.0.1",',
      "  fetch(req) {",
      '    if (new URL(req.url).pathname === "/__test_shutdown__") {',
      "      setTimeout(() => process.exit(0), 10);",
      '      return new Response("ok");',
      "    }",
      '    return new Response("{}", { status: 200 });',
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(shimPath, 0o755);
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

// Skips (rather than fails) when a real server is already answering on a
// default candidate port -- mirrors the same defensive skip used by
// detectOpencodePort's "falls back"/"returns null" tests above, for the
// same reason: this environment's ports aren't under the test's control.
async function candidatePortsAreFree(): Promise<boolean> {
  return !(await checkHealth(4096)) && !(await checkHealth(4097));
}

describe("ensureOpencodeServer", () => {
  it("returns the existing server's port without spawning when one is already healthy", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = requirePort(server);
    process.env.MANDO_OPENCODE_PORT = String(port);
    // A binary that does not exist: if ensureOpencodeServer tried to spawn
    // it anyway, this would throw. A clean return proves detection
    // short-circuited before the spawn path ever ran.
    process.env.MANDO_OPENCODE_BIN = "/nonexistent/mando-test-opencode-bin";

    expect(await ensureOpencodeServer(process.cwd())).toBe(port);
  });

  it("spawns the opencode binary and returns a port that answers /doc when none is detected", async () => {
    if (!(await candidatePortsAreFree())) return;

    process.env.MANDO_OPENCODE_PORT = "1"; // reserved port, guaranteed closed -- forces detection past the override
    process.env.MANDO_OPENCODE_BIN = shimPath;

    const port = await ensureOpencodeServer(shimDir);
    try {
      expect(await checkHealth(port)).toBe(true);
    } finally {
      await fetch(`http://127.0.0.1:${port}/__test_shutdown__`).catch(() => {});
    }
  }, 10_000);

  it("throws a clear error when the opencode binary cannot be found", async () => {
    if (!(await candidatePortsAreFree())) return;

    process.env.MANDO_OPENCODE_PORT = "1";
    process.env.MANDO_OPENCODE_BIN = "/nonexistent/mando-test-opencode-bin";

    await expect(ensureOpencodeServer(shimDir)).rejects.toThrow(/could not start opencode serve/);
  });
});

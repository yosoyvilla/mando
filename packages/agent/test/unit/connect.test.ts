import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../../src/connect";
import { readConfig } from "../../src/config";

let configDir: string | null = null;
let originalConsoleLog: typeof console.log;
let logs: string[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "mando-connect-test-"));
  process.env.MANDO_CONFIG = join(configDir, "config.json");
  // connect() now also consults the pidfile (see the already-running-daemon
  // guard) on every call -- pin it to a per-test tmp path so these tests
  // never read/depend on a real ~/.mando-pid left over on the host.
  process.env.MANDO_PID_FILE = join(configDir, "pid");
  logs = [];
  originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalConsoleLog;
  delete process.env.MANDO_CONFIG;
  delete process.env.MANDO_PID_FILE;
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

// A tiny stub for the hub's pairing endpoints -- POST /pairing/request
// returns a fixed code immediately; GET /pairing/status reports "pending"
// for the first `pendingPolls` calls, then "approved" with a token. This
// is deliberately not the real hub (no Postgres, no pairing/service.ts) --
// connect()'s pairing orchestration (request -> print -> poll -> store) is
// what's under test here, not the hub's pairing logic itself (covered by
// apps/hub/test/integration/pairing.test.ts).
function startPairingStub(opts: { pendingPolls: number }): { server: ReturnType<typeof Bun.serve>; url: string } {
  let polls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/v1/pairing/request") {
        return Response.json({ code: "ABCD-1234", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/pairing/status") {
        polls++;
        if (polls > opts.pendingPolls) {
          return Response.json({ status: "approved", token: "tok-id.secret" }, { status: 200 });
        }
        return Response.json({ status: "pending" }, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://localhost:${server.port}` };
}

describe("connect (pairing flow)", () => {
  it("prints the pairing code, polls until approved, stores the token, then spawns and prints connected", async () => {
    const { server, url } = startPairingStub({ pendingPolls: 2 });
    const spawnCalls: number[] = [];

    try {
      const result = await connect({
        hub: url,
        opencodePort: 4096,
        pairingPollIntervalMs: 5,
        spawnDaemon: (port) => {
          spawnCalls.push(port);
          return 12345;
        },
      });

      expect(result).toEqual({ status: "connected", machine: expect.any(String), uiUrl: url });

      const pairingLog = logs.find((l) => l.includes("Pairing code: ABCD-1234"));
      expect(pairingLog).toBeDefined();

      const connectedLog = logs.find((l) => l.includes("Connected as"));
      expect(connectedLog).toBeDefined();

      expect(spawnCalls).toEqual([4096]);

      const config = readConfig();
      expect(config?.token).toBe("tok-id.secret");
      expect(config?.hubUrl).toBe(url);
    } finally {
      server.stop(true);
    }
  });

  it("treats an unparseable 2xx pairing-status body as still pending and keeps polling", async () => {
    let polls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/v1/pairing/request") {
          return Response.json(
            { code: "BADJ-SON1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
            { status: 201 },
          );
        }
        if (req.method === "GET" && url.pathname === "/api/v1/pairing/status") {
          polls++;
          // A 2xx response with a body that isn't valid JSON at all -- must
          // not throw out of connect() as an unhandled rejection; the
          // "treat non-approved as pending" comment should also cover a
          // response that can't even be parsed.
          if (polls <= 2) return new Response("not json", { status: 200 });
          return Response.json({ status: "approved", token: "tok-recovered" }, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const url = `http://localhost:${server.port}`;

    try {
      const result = await connect({
        hub: url,
        opencodePort: 4096,
        pairingPollIntervalMs: 5,
        spawnDaemon: () => 1,
      });

      expect(result).toEqual({ status: "connected", machine: expect.any(String), uiUrl: url });
      expect(polls).toBeGreaterThanOrEqual(3);

      const config = readConfig();
      expect(config?.token).toBe("tok-recovered");
    } finally {
      server.stop(true);
    }
  });

  it("returns an error result (and prints one) when the pairing code expires before approval", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/v1/pairing/request") {
          // Already expired by the time connect() polls.
          return Response.json({ code: "DEAD-CODE", expiresAt: new Date(Date.now() - 1).toISOString() }, { status: 201 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const url = `http://localhost:${server.port}`;

    try {
      const result = await connect({ hub: url, pairingPollIntervalMs: 5, spawnDaemon: () => 1 });
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.message).toContain("expired");
    } finally {
      server.stop(true);
    }
  });

  it("skips pairing entirely when a token is already configured, going straight to detect+spawn", async () => {
    const { writeConfig } = await import("../../src/config");
    writeConfig({ hubUrl: "http://existing.invalid", token: "already-have-one", machineName: "known-machine" });

    const spawnCalls: number[] = [];
    const result = await connect({
      opencodePort: 4097,
      spawnDaemon: (port) => {
        spawnCalls.push(port);
        return 1;
      },
    });

    expect(result).toEqual({ status: "connected", machine: "known-machine", uiUrl: "http://existing.invalid" });
    expect(spawnCalls).toEqual([4097]);
    expect(logs.some((l) => l.includes("Pairing code"))).toBe(false);
  });

  it("returns an error when no hub URL can be resolved", async () => {
    const result = await connect({});
    expect(result.status).toBe("error");
  });

  it("returns an error when opencode detection fails and no explicit port was given", async () => {
    const { writeConfig } = await import("../../src/config");
    writeConfig({ hubUrl: "http://existing.invalid", token: "tok", machineName: "m" });

    const result = await connect({ detectOpencodePort: async () => null, spawnDaemon: () => 1 });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("opencode");
  });

  it("does not spawn a second daemon when one is already running, and reports it as connected instead", async () => {
    const { writeConfig } = await import("../../src/config");
    writeConfig({ hubUrl: "http://existing.invalid", token: "already-have-one", machineName: "known-machine" });

    const fakeRunningPid = 424242;
    const spawnCalls: number[] = [];
    const opts = {
      opencodePort: 4097,
      spawnDaemon: (port: number) => {
        spawnCalls.push(port);
        // Mirrors what the real defaultSpawnDaemon does: write the pidfile
        // synchronously right after spawning, before connect() returns.
        writeFileSync(process.env.MANDO_PID_FILE!, String(fakeRunningPid), "utf-8");
        return fakeRunningPid;
      },
      isProcessAlive: (pid: number) => pid === fakeRunningPid,
    };

    const first = await connect(opts);
    expect(first).toEqual({ status: "connected", machine: "known-machine", uiUrl: "http://existing.invalid" });
    expect(spawnCalls).toEqual([4097]);

    // Second call: the pidfile from the first call is still there and
    // isProcessAlive says it's live -- must report "already running"
    // rather than calling spawnDaemon again.
    const second = await connect(opts);
    expect(second).toEqual({
      status: "connected",
      machine: "known-machine",
      uiUrl: "http://existing.invalid",
      alreadyRunning: true,
    });
    expect(spawnCalls).toEqual([4097]); // still only the one spawn call from the first connect()
  });

  it("spawns again when the pidfile is stale (its pid is no longer alive)", async () => {
    const { writeConfig } = await import("../../src/config");
    writeConfig({ hubUrl: "http://existing.invalid", token: "already-have-one", machineName: "known-machine" });

    writeFileSync(process.env.MANDO_PID_FILE!, "999999", "utf-8");

    const spawnCalls: number[] = [];
    const result = await connect({
      opencodePort: 4097,
      spawnDaemon: (port: number) => {
        spawnCalls.push(port);
        return 555;
      },
      isProcessAlive: () => false, // stale pidfile -- the recorded pid is dead
    });

    expect(result).toEqual({ status: "connected", machine: "known-machine", uiUrl: "http://existing.invalid" });
    expect(spawnCalls).toEqual([4097]);
  });
});

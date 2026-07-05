import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, formatDoctorReport, type DoctorCheck } from "../../src/doctor";
import { writeConfig } from "../../src/config";
import { writePidFile } from "../../src/daemon";
import type { ExecResult } from "../../src/autostart";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mando-doctor-test-"));
  process.env.MANDO_CONFIG = join(workDir, "config.json");
  process.env.MANDO_PID_FILE = join(workDir, "pid");
  process.env.OPENCODE_CONFIG_DIR = join(workDir, "opencode-config");
});

afterEach(() => {
  delete process.env.MANDO_CONFIG;
  delete process.env.MANDO_PID_FILE;
  delete process.env.OPENCODE_CONFIG_DIR;
  rmSync(workDir, { recursive: true, force: true });
});

function installCommandFiles(): void {
  const commandsDir = join(process.env.OPENCODE_CONFIG_DIR!, "commands");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, "mando.md"), "mando", "utf-8");
  writeFileSync(join(commandsDir, "mando-refresh.md"), "mando-refresh", "utf-8");
}

function passingExec(): ExecResult {
  return { status: 0, stdout: "1.2.3", stderr: "" };
}

function findCheck(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`no check named ${name}`);
  return check;
}

describe("runDoctor", () => {
  it("reports every check as pass and ok=true when the whole setup is healthy", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", token: "tok", machineName: "m" });
    writePidFile(process.env.MANDO_PID_FILE!, process.pid);
    installCommandFiles();

    const report = await runDoctor({
      fetchFn: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      exec: passingExec,
      detectOpencodePort: async () => 4096,
      isProcessAlive: (pid) => pid === process.pid,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "pass"]);
    expect(findCheck(report.checks, "config").detail).toContain("http://hub.invalid");
    expect(findCheck(report.checks, "daemon").detail).toContain(String(process.pid));
    expect(findCheck(report.checks, "opencode-server").detail).toContain("4096");
    expect(findCheck(report.checks, "opencode-binary").detail).toContain("1.2.3");
  });

  it("fails config and skips token/hub when there is no config at all, but still runs the config-independent checks", async () => {
    const report = await runDoctor({
      exec: passingExec,
      detectOpencodePort: async () => null,
      isProcessAlive: () => false,
    });

    expect(findCheck(report.checks, "config")).toEqual({
      name: "config",
      status: "fail",
      detail: "no config found -- run `mando connect --hub <url>`",
    });
    expect(findCheck(report.checks, "token").status).toBe("skip");
    expect(findCheck(report.checks, "hub").status).toBe("skip");
    expect(findCheck(report.checks, "daemon").status).toBe("fail");
    expect(findCheck(report.checks, "opencode-server").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails token when configured but never paired", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", machineName: "m" });

    const report = await runDoctor({
      fetchFn: async () => new Response("ok", { status: 200 }),
      exec: passingExec,
      detectOpencodePort: async () => 4096,
      isProcessAlive: () => false,
    });

    expect(findCheck(report.checks, "token").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails the hub check when the request throws (network error)", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", token: "tok", machineName: "m" });

    const report = await runDoctor({
      fetchFn: async () => {
        throw new Error("fetch failed: connection refused");
      },
      exec: passingExec,
      detectOpencodePort: async () => 4096,
      isProcessAlive: () => true,
    });

    const hub = findCheck(report.checks, "hub");
    expect(hub.status).toBe("fail");
    expect(hub.detail).toContain("connection refused");
  });

  it("fails the hub check when /healthz responds with a non-2xx status", async () => {
    writeConfig({ hubUrl: "http://hub.invalid", token: "tok", machineName: "m" });

    const report = await runDoctor({
      fetchFn: async () => new Response("bad gateway", { status: 502 }),
      exec: passingExec,
      detectOpencodePort: async () => 4096,
      isProcessAlive: () => true,
    });

    const hub = findCheck(report.checks, "hub");
    expect(hub.status).toBe("fail");
    expect(hub.detail).toContain("502");
  });

  it("fails the daemon check with a distinct message for a stale pidfile vs. no pidfile", async () => {
    writePidFile(process.env.MANDO_PID_FILE!, 999999);

    const report = await runDoctor({
      exec: passingExec,
      detectOpencodePort: async () => null,
      isProcessAlive: (pid) => pid !== 999999,
    });

    const daemon = findCheck(report.checks, "daemon");
    expect(daemon.status).toBe("fail");
    expect(daemon.detail).toContain("stale pidfile");
    expect(daemon.detail).toContain("999999");
  });

  it("fails the opencode-server check when detection finds nothing", async () => {
    const report = await runDoctor({ exec: passingExec, detectOpencodePort: async () => null, isProcessAlive: () => false });
    expect(findCheck(report.checks, "opencode-server").status).toBe("fail");
  });

  it("fails the opencode-binary check when the exec runner reports a non-zero exit (binary missing)", async () => {
    const report = await runDoctor({
      exec: () => ({ status: 1, stdout: "", stderr: "command not found" }),
      detectOpencodePort: async () => null,
      isProcessAlive: () => false,
    });

    const binary = findCheck(report.checks, "opencode-binary");
    expect(binary.status).toBe("fail");
    expect(binary.detail).toContain("opencode");
  });

  it("fails the commands check and names the specific missing file(s)", async () => {
    const report = await runDoctor({ exec: passingExec, detectOpencodePort: async () => null, isProcessAlive: () => false });

    const commands = findCheck(report.checks, "commands");
    expect(commands.status).toBe("fail");
    expect(commands.detail).toContain("mando.md");
    expect(commands.detail).toContain("mando-refresh.md");
  });

  it("passes the commands check once both command files exist", async () => {
    installCommandFiles();

    const report = await runDoctor({ exec: passingExec, detectOpencodePort: async () => null, isProcessAlive: () => false });

    expect(findCheck(report.checks, "commands").status).toBe("pass");
  });
});

describe("formatDoctorReport", () => {
  it("renders one uppercase-status line per check", () => {
    const report = {
      checks: [
        { name: "config", status: "pass", detail: "hub URL configured: http://hub.invalid" },
        { name: "token", status: "fail", detail: "not paired" },
        { name: "hub", status: "skip", detail: "no hub URL configured" },
      ] as DoctorCheck[],
      ok: false,
    };

    const output = formatDoctorReport(report);
    expect(output).toBe(
      [
        "PASS  config: hub URL configured: http://hub.invalid",
        "FAIL  token: not paired",
        "SKIP  hub: no hub URL configured",
      ].join("\n"),
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableAutostart, disableAutostart, autostartStatus, type ExecResult } from "../../src/autostart";
import { writeConfig } from "../../src/config";

// None of these tests ever invoke a real launchctl/systemctl/loginctl --
// every exec() passed in is a fake that just records its argv (per the plan's
// "inject the exec runner like connect.ts's test seams" requirement).
// Isolation is via $HOME (autostart.ts's paths are join(homedir(), ...), and
// node's homedir() honors $HOME) and MANDO_CONFIG, mirroring the rest of the
// suite's MANDO_CONFIG/HOME override pattern.

let homeDir: string;
let platformDescriptor: PropertyDescriptor | undefined;

function setPlatform(platform: string): void {
  platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeExec(handler?: (cmd: string, args: string[]) => ExecResult | undefined): {
  exec: (cmd: string, args: string[]) => ExecResult;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec = (cmd: string, args: string[]): ExecResult => {
    calls.push({ cmd, args });
    return handler?.(cmd, args) ?? { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "mando-autostart-test-"));
  process.env.HOME = homeDir;
  process.env.MANDO_CONFIG = join(homeDir, "config.json");
});

afterEach(() => {
  restorePlatform();
  delete process.env.MANDO_CONFIG;
  rmSync(homeDir, { recursive: true, force: true });
});

describe("autostart on macOS", () => {
  beforeEach(() => setPlatform("darwin"));

  it("writes a launchd plist with RunAtLoad, the resolved working directory, and connect --opencode-auto, then bootstraps + enables via the injected exec runner", () => {
    const { exec, calls } = fakeExec();

    const result = enableAutostart({ exec, connectDirectory: "/Users/dev/project" });

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.mando.agent.plist");
    expect(result).toEqual({ status: "enabled", message: `Autostart enabled (${plistPath}).`, path: plistPath });
    expect(existsSync(plistPath)).toBe(true);

    const content = readFileSync(plistPath, "utf-8");
    expect(content).toContain("<key>RunAtLoad</key>");
    expect(content).toContain("<true/>");
    expect(content).toContain("<string>/Users/dev/project</string>");
    expect(content).toContain(`<string>${process.execPath}</string>`);
    expect(content).toContain("<string>connect</string>");
    expect(content).toContain("<string>--opencode-auto</string>");

    const uid = process.getuid!();
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootstrap", `gui/${uid}`, plistPath] },
      { cmd: "launchctl", args: ["enable", `gui/${uid}/com.mando.agent`] },
    ]);
  });

  it("treats a launchctl bootstrap failure (already loaded) as a successful, idempotent enable", () => {
    const { exec } = fakeExec((cmd, args) =>
      args[0] === "bootstrap" ? { status: 1, stdout: "", stderr: "service already loaded" } : undefined,
    );

    const result = enableAutostart({ exec, connectDirectory: "/x" });
    expect(result.status).toBe("enabled");
  });

  it("reports an error (not enabled) when launchctl enable itself fails", () => {
    const { exec } = fakeExec((cmd, args) =>
      args[0] === "enable" ? { status: 1, stdout: "", stderr: "no such service" } : undefined,
    );

    const result = enableAutostart({ exec, connectDirectory: "/x" });
    expect(result.status).toBe("error");
    expect(result.message).toContain("no such service");
  });

  it("disable bootouts the service via the exec runner and removes the plist", () => {
    const setup = fakeExec();
    enableAutostart({ exec: setup.exec, connectDirectory: "/x" });
    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.mando.agent.plist");
    expect(existsSync(plistPath)).toBe(true);

    const { exec, calls } = fakeExec();
    const result = disableAutostart({ exec });

    expect(result).toEqual({ status: "disabled", message: `Autostart disabled (${plistPath} removed).`, path: plistPath });
    expect(existsSync(plistPath)).toBe(false);
    const uid = process.getuid!();
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/${uid}/com.mando.agent`] }]);
  });

  it("disable succeeds even when nothing was ever enabled (no plist, launchctl bootout still called)", () => {
    const { exec } = fakeExec();
    const result = disableAutostart({ exec });
    expect(result.status).toBe("disabled");
  });

  it("status reports disabled with no plist on disk, and enabled once enableAutostart has written one", () => {
    expect(autostartStatus().status).toBe("disabled");

    const { exec } = fakeExec();
    enableAutostart({ exec, connectDirectory: "/x" });

    expect(autostartStatus().status).toBe("enabled");
  });

  it("falls back to the config's lastConnect.connectDirectory when no explicit directory is given", () => {
    writeConfig({
      hubUrl: "http://hub.invalid",
      machineName: "m",
      lastConnect: { opencodePort: 4096, connectDirectory: "/from/config" },
    });
    const { exec } = fakeExec();

    enableAutostart({ exec });

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.mando.agent.plist");
    const content = readFileSync(plistPath, "utf-8");
    expect(content).toContain("<string>/from/config</string>");
  });

  it("falls back to the current working directory when there is no config at all", () => {
    const { exec } = fakeExec();
    enableAutostart({ exec });

    const plistPath = join(homeDir, "Library", "LaunchAgents", "com.mando.agent.plist");
    const content = readFileSync(plistPath, "utf-8");
    expect(content).toContain(`<string>${process.cwd()}</string>`);
  });
});

describe("autostart on Linux", () => {
  beforeEach(() => setPlatform("linux"));

  it("writes a systemd user unit (Type=oneshot), enables it, and enables linger for the current user", () => {
    const { exec, calls } = fakeExec();

    const result = enableAutostart({ exec, connectDirectory: "/srv/project" });

    const servicePath = join(homeDir, ".config", "systemd", "user", "mando.service");
    expect(result.status).toBe("enabled");
    expect(result.path).toBe(servicePath);
    expect(existsSync(servicePath)).toBe(true);

    const content = readFileSync(servicePath, "utf-8");
    expect(content).toContain("Type=oneshot");
    expect(content).toContain("WorkingDirectory=/srv/project");
    expect(content).toContain(`ExecStart=${process.execPath} connect --opencode-auto`);
    expect(content).toContain("WantedBy=default.target");

    expect(calls[0]).toEqual({ cmd: "systemctl", args: ["--user", "enable", "mando.service"] });
    expect(calls[1].cmd).toBe("loginctl");
    expect(calls[1].args[0]).toBe("enable-linger");
  });

  it("reports an error and never calls loginctl when systemctl --user enable fails", () => {
    const { exec, calls } = fakeExec((cmd) => (cmd === "systemctl" ? { status: 1, stdout: "", stderr: "unit not found" } : undefined));

    const result = enableAutostart({ exec, connectDirectory: "/x" });

    expect(result.status).toBe("error");
    expect(result.message).toContain("unit not found");
    expect(calls.some((c) => c.cmd === "loginctl")).toBe(false);
  });

  it("reports an error when loginctl enable-linger fails, even though the unit was enabled", () => {
    const { exec } = fakeExec((cmd) => (cmd === "loginctl" ? { status: 1, stdout: "", stderr: "dbus error" } : undefined));

    const result = enableAutostart({ exec, connectDirectory: "/x" });

    expect(result.status).toBe("error");
    expect(result.message).toContain("linger");
  });

  it("disable disables the unit but does NOT touch linger, and removes the unit file", () => {
    const setup = fakeExec();
    enableAutostart({ exec: setup.exec, connectDirectory: "/x" });
    const servicePath = join(homeDir, ".config", "systemd", "user", "mando.service");

    const { exec, calls } = fakeExec();
    const result = disableAutostart({ exec });

    expect(result.status).toBe("disabled");
    expect(calls).toEqual([{ cmd: "systemctl", args: ["--user", "disable", "mando.service"] }]);
    expect(calls.some((c) => c.cmd === "loginctl")).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
  });

  it("status reports disabled with no unit file on disk, and enabled once enableAutostart has written one", () => {
    expect(autostartStatus().status).toBe("disabled");

    const { exec } = fakeExec();
    enableAutostart({ exec, connectDirectory: "/x" });

    expect(autostartStatus().status).toBe("enabled");
  });
});

describe("autostart on unsupported platforms", () => {
  beforeEach(() => setPlatform("win32"));

  it("refuses gracefully on enable/disable/status without invoking exec or touching the filesystem", () => {
    const { exec, calls } = fakeExec();

    expect(enableAutostart({ exec, connectDirectory: "/x" }).status).toBe("unsupported");
    expect(disableAutostart({ exec }).status).toBe("unsupported");
    expect(autostartStatus().status).toBe("unsupported");
    expect(calls).toEqual([]);
  });
});

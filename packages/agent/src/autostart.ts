import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { readConfig } from "./config";

// The subset of a completed subprocess run autostart needs -- just enough
// to check success and read diagnostic text on failure. `Bun.spawnSync`'s
// return value already satisfies this structurally; tests substitute a
// much smaller fake that never invokes launchctl/systemctl/loginctl for
// real (see autostart.test.ts).
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ExecRunner = (cmd: string, args: string[]) => ExecResult;

// Exported for doctor.ts, which runs a diagnostic `<bin> --version` through
// this same seam -- a missing binary is exactly one of the things doctor
// checks for, so unlike autostart's own launchctl/systemctl/loginctl calls
// (present on their respective OS in practice), a throw here is an
// expected, not exceptional, outcome and must come back as a normal failed
// ExecResult rather than an uncaught exception.
export function defaultExec(cmd: string, args: string[]): ExecResult {
  try {
    const result = Bun.spawnSync([cmd, ...args]);
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (error) {
    return { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

export interface AutostartOpts {
  // Test-only injection point, mirroring connect.ts's ConnectOpts style --
  // the real default below is the only thing that ever touches
  // launchctl/systemctl/loginctl; tests always pass a fake.
  exec?: ExecRunner;
  // The directory the autostarted `connect --opencode-auto` should run
  // from. Defaults to the last successful `mando connect`'s directory (see
  // config.ts's AgentConfig.lastConnect, written by connect.ts), falling
  // back to the current directory if this machine has never connected yet.
  connectDirectory?: string;
}

export interface AutostartResult {
  status: "enabled" | "disabled" | "error" | "unsupported";
  message: string;
  path?: string;
}

// Reads $HOME directly rather than calling node:os's homedir() -- Bun
// caches homedir() at process startup (verified against bun 1.3.14: it does
// not re-read $HOME set at runtime the way Node's implementation does), so
// tests that set process.env.HOME to a per-test tmp dir (the same pattern
// the rest of this suite uses for MANDO_CONFIG etc.) would otherwise be
// silently ignored. $HOME is the same source homedir() itself derives from
// on POSIX, so this is equivalent in real use and testable in-process here.
function autostartHomeDir(): string {
  return process.env.HOME ?? homedir();
}

function macPlistPath(): string {
  return join(autostartHomeDir(), "Library", "LaunchAgents", "com.mando.agent.plist");
}

function linuxServicePath(): string {
  return join(autostartHomeDir(), ".config", "systemd", "user", "mando.service");
}

function resolveConnectDirectory(explicit?: string): string {
  if (explicit) return explicit;
  return readConfig()?.lastConnect?.connectDirectory ?? process.cwd();
}

function renderLaunchdPlist(execPath: string, workingDirectory: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.mando.agent</string>
	<key>ProgramArguments</key>
	<array>
		<string>${execPath}</string>
		<string>connect</string>
		<string>--opencode-auto</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${workingDirectory}</string>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
`;
}

function renderSystemdUnit(execPath: string, workingDirectory: string): string {
  return `[Unit]
Description=Mando agent

[Service]
Type=oneshot
WorkingDirectory=${workingDirectory}
ExecStart=${execPath} connect --opencode-auto

[Install]
WantedBy=default.target
`;
}

function writeFileWithParents(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

// enableAutostart writes the platform-specific launch definition (a
// launchd plist on macOS, a systemd user unit on Linux) pointed at this
// same compiled binary (`process.execPath` -- never a repo file, per the
// compiled-binary rule: a released `mando` binary has no source tree on
// the target machine for launchd/systemd to spawn `bun` against) running
// `connect --opencode-auto` from the resolved working directory, then asks
// the OS service manager to load and enable it.
export function enableAutostart(opts: AutostartOpts = {}): AutostartResult {
  const exec = opts.exec ?? defaultExec;
  const workingDirectory = resolveConnectDirectory(opts.connectDirectory);

  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    writeFileWithParents(plistPath, renderLaunchdPlist(process.execPath, workingDirectory));

    const uid = process.getuid?.();
    if (uid === undefined) {
      return { status: "error", message: "could not determine the current user id (process.getuid is unavailable)" };
    }
    const domain = `gui/${uid}`;

    // `launchctl bootstrap` exits non-zero when the service is already
    // loaded (plan-critic REQUIRED amendment: `launchctl load -w` is
    // deprecated and flaky against the disabled-services override list,
    // but `bootstrap` itself is not idempotent either) -- its own result is
    // deliberately ignored here so a second `mando autostart enable` still
    // reports success rather than failing on an already-loaded service;
    // any genuine failure (a malformed plist, a permissions problem) would
    // also surface as a non-zero exit here, but launchctl gives no
    // reliable machine-readable way to distinguish the two across macOS
    // versions, so bootstrap failures are treated as non-fatal and the
    // subsequent `enable` call is what's actually checked below.
    exec("launchctl", ["bootstrap", domain, plistPath]);

    const enableResult = exec("launchctl", ["enable", `${domain}/com.mando.agent`]);
    if (enableResult.status !== 0) {
      const detail = enableResult.stderr.trim() || enableResult.stdout.trim() || `exit ${enableResult.status}`;
      return { status: "error", message: `launchctl enable failed: ${detail}`, path: plistPath };
    }

    return { status: "enabled", message: `Autostart enabled (${plistPath}).`, path: plistPath };
  }

  if (process.platform === "linux") {
    const servicePath = linuxServicePath();
    writeFileWithParents(servicePath, renderSystemdUnit(process.execPath, workingDirectory));

    const enableResult = exec("systemctl", ["--user", "enable", "mando.service"]);
    if (enableResult.status !== 0) {
      const detail = enableResult.stderr.trim() || enableResult.stdout.trim() || `exit ${enableResult.status}`;
      return { status: "error", message: `systemctl --user enable failed: ${detail}`, path: servicePath };
    }

    // REQUIRED: without linger, systemd tears down a user's units (and
    // their manager) the moment their last session ends -- so a user unit
    // enabled with WantedBy=default.target simply never runs at boot when
    // nobody is logged in, which is exactly the scenario autostart exists
    // for. Run unconditionally on every enable, not just the first, so a
    // linger revoked by some other tool gets restored.
    const username = userInfo().username;
    const lingerResult = exec("loginctl", ["enable-linger", username]);
    if (lingerResult.status !== 0) {
      const detail = lingerResult.stderr.trim() || lingerResult.stdout.trim() || `exit ${lingerResult.status}`;
      return { status: "error", message: `loginctl enable-linger failed: ${detail}`, path: servicePath };
    }

    return {
      status: "enabled",
      message: `Autostart enabled (${servicePath}). Linger enabled for ${username}.`,
      path: servicePath,
    };
  }

  return { status: "unsupported", message: `autostart is not supported on ${process.platform}` };
}

// disableAutostart unloads the service (best-effort -- a service that was
// never loaded, or already unloaded, is not an error) and removes the
// launch definition file. On Linux, deliberately does NOT revoke linger
// (see loginctl enable-linger comment above): other systemd user units on
// this machine may depend on it staying enabled, so disabling autostart
// alone must not silently break them.
export function disableAutostart(opts: AutostartOpts = {}): AutostartResult {
  const exec = opts.exec ?? defaultExec;

  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    const uid = process.getuid?.();
    if (uid !== undefined) {
      exec("launchctl", ["bootout", `gui/${uid}/com.mando.agent`]);
    }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    return { status: "disabled", message: `Autostart disabled (${plistPath} removed).`, path: plistPath };
  }

  if (process.platform === "linux") {
    const servicePath = linuxServicePath();
    exec("systemctl", ["--user", "disable", "mando.service"]);
    if (existsSync(servicePath)) unlinkSync(servicePath);
    return {
      status: "disabled",
      message: `Autostart disabled (${servicePath} removed). Linger left enabled -- other units may depend on it; run 'loginctl disable-linger $(whoami)' yourself if you want to revoke it too.`,
      path: servicePath,
    };
  }

  return { status: "unsupported", message: `autostart is not supported on ${process.platform}` };
}

// autostartStatus never invokes launchctl/systemctl -- it answers from disk
// presence alone (whether the launch definition file this module writes
// exists), matching how `mando status` (see index.ts) already reports
// on-disk state without touching the network or spawning anything.
export function autostartStatus(): AutostartResult {
  if (process.platform === "darwin") {
    const plistPath = macPlistPath();
    return existsSync(plistPath)
      ? { status: "enabled", message: `Autostart enabled (${plistPath}).`, path: plistPath }
      : { status: "disabled", message: "Autostart disabled.", path: plistPath };
  }

  if (process.platform === "linux") {
    const servicePath = linuxServicePath();
    return existsSync(servicePath)
      ? { status: "enabled", message: `Autostart enabled (${servicePath}).`, path: servicePath }
      : { status: "disabled", message: "Autostart disabled.", path: servicePath };
  }

  return { status: "unsupported", message: `autostart is not supported on ${process.platform}` };
}

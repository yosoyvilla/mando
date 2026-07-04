export * from "./config";
export * from "./reconnect";
export * from "./opencode";
export * from "./forward";
export * from "./connect";
export * from "./daemon";

import { readConfig } from "./config";
import { connect, printResult, type ConnectOpts, type ConnectResult } from "./connect";
import { defaultPidFilePath, defaultStateFilePath, readPidFile, readStateFile, removePidFile } from "./daemon";

export type DisconnectResult =
  | { status: "disconnected" }
  | { status: "not_running" }
  | { status: "error"; message: string };

// True if a process with this pid exists and is signalable by us. Sending
// signal 0 is the standard POSIX/Node idiom for a liveness check -- it
// delivers no actual signal, just runs the permission/existence checks
// `kill` would otherwise do.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// disconnect() reads the pidfile daemon.ts wrote (see connect.ts's
// defaultSpawnDaemon) and signals that process to stop. SIGTERM (not
// SIGKILL) so the daemon's own signal handler (wired in daemon.ts's
// `import.meta.main` block) gets a chance to close its socket, abort
// in-flight requests, and remove the pidfile itself; this function
// removes the pidfile too, defensively, in case the process was already
// gone (a stale pidfile from a crashed daemon) or didn't get to clean up.
export function disconnect(opts: { json?: boolean } = {}): DisconnectResult {
  const pidFile = defaultPidFilePath();
  const pid = readPidFile(pidFile);

  if (pid === null) {
    printResult(opts.json, { status: "not_running" }, "Not connected (no pidfile found).");
    return { status: "not_running" };
  }

  if (!isProcessAlive(pid)) {
    removePidFile(pidFile);
    printResult(opts.json, { status: "not_running" }, "Not connected (stale pidfile removed).");
    return { status: "not_running" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const message = `failed to signal daemon process ${pid}: ${error instanceof Error ? error.message : String(error)}`;
    printResult(opts.json, { status: "error", message }, `Error: ${message}`);
    return { status: "error", message };
  }

  removePidFile(pidFile);
  printResult(opts.json, { status: "disconnected" }, "Disconnected.");
  return { status: "disconnected" };
}

export interface StatusResult {
  configured: boolean;
  hubUrl?: string;
  machineName?: string;
  hasToken: boolean;
  daemonRunning: boolean;
  pid?: number;
  lastSeenAt?: string;
}

// status() reports what's on disk (config, pidfile, last-seen state file)
// without touching the network -- it's meant to answer "is this machine
// set up to connect, is the daemon currently alive, and when did it last
// check in" for `mando status` / the shell-injection prompt, not "is the
// hub currently reachable".
export function status(opts: { json?: boolean } = {}): StatusResult {
  const config = readConfig();
  const pidFile = defaultPidFilePath();
  const pid = readPidFile(pidFile);
  const daemonRunning = pid !== null && isProcessAlive(pid);
  const state = readStateFile(defaultStateFilePath());

  const result: StatusResult = {
    configured: config !== null,
    hubUrl: config?.hubUrl,
    machineName: config?.machineName,
    hasToken: Boolean(config?.token),
    daemonRunning,
    pid: daemonRunning ? (pid ?? undefined) : undefined,
    lastSeenAt: state?.lastSeenAt,
  };

  const human = config
    ? `Machine: ${config.machineName}\nHub: ${config.hubUrl}\nToken: ${result.hasToken ? "present" : "missing"}\nDaemon: ${daemonRunning ? `running (pid ${pid})` : "not running"}\nLast seen: ${result.lastSeenAt ?? "never"}`
    : `Not configured. Run \`mando connect\` first.`;
  printResult(opts.json, result as unknown as Record<string, unknown>, human);

  return result;
}

function parseArgs(argv: string[]): ConnectOpts {
  const opts: ConnectOpts = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        opts.json = true;
        break;
      case "--opencode-auto":
        opts.opencodeAuto = true;
        break;
      case "--opencode-port":
        opts.opencodePort = Number(argv[++i]);
        break;
      case "--hub":
        opts.hub = argv[++i];
        break;
      default:
        positional.push(arg);
    }
  }

  opts.args = positional;
  return opts;
}

// installCommand is task 3.5's shell-injection installer (writing the
// `/mando` slash-command wrapper into the user's shell/agent config). Left
// unimplemented here on purpose -- the "install-command" subcommand below
// already routes to it so 3.5 only has to fill in this one function body,
// not touch the CLI dispatch switch.
function installCommand(_opts: ConnectOpts): number {
  console.error("mando install-command: not yet implemented (task 3.5)");
  return 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (command) {
    case "connect": {
      const result: ConnectResult = await connect(opts);
      process.exitCode = result.status === "error" ? 1 : 0;
      return;
    }
    case "disconnect": {
      const result = disconnect(opts);
      process.exitCode = result.status === "error" ? 1 : 0;
      return;
    }
    case "status": {
      status(opts);
      return;
    }
    case "install-command": {
      process.exitCode = installCommand(opts);
      return;
    }
    default: {
      console.error("Usage: mando <connect|disconnect|status|install-command> [--json] [--hub <url>] [--opencode-port <port>] [--opencode-auto]");
      process.exitCode = command ? 1 : 0;
      return;
    }
  }
}

if (import.meta.main) {
  void main();
}

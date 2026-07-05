import { readConfig } from "./config";
import { checkHealth as defaultCheckHealth, ensureOpencodeServer as defaultEnsureOpencodeServer } from "./opencode";
import { defaultSpawnDaemon } from "./connect";
import { defaultPidFilePath, isProcessAlive as defaultIsProcessAlive, readPidFile } from "./daemon";

// The minimal shape runTui needs from a spawned attach child -- just enough
// to await its real exit code. `Bun.spawn`'s return value already satisfies
// this structurally (its `.exited` is a `Promise<number>`), so the real
// default below needs no adapter; tests substitute a much smaller fake that
// never touches a real process.
export interface SpawnedProcess {
  pid: number;
  exited: Promise<number>;
}

export interface TuiOpts {
  dir?: string;
  opencodePort?: number;
  // Test-only injection points, mirroring connect.ts's ConnectOpts style --
  // none of these change runTui()'s documented behavior, they only let
  // tests swap the real network/process calls for deterministic stand-ins.
  checkHealth?: (port: number) => Promise<boolean>;
  ensureOpencodeServer?: (directory: string) => Promise<number>;
  spawnDaemon?: (opencodePort: number, connectDirectory: string) => number;
  isProcessAlive?: (pid: number) => boolean;
  spawn?: (args: string[]) => SpawnedProcess;
}

// runTui implements `mando tui`: ensure a local opencode server, ensure the
// daemon is running when this machine is paired with a hub, then hand the
// terminal over to `opencode attach` and wait for it to exit -- see
// docs/superpowers/plans/2026-07-05-mando-tui-attach.md, Task 1's behavior
// contract for the numbered rules this function implements.
export async function runTui(opts: TuiOpts = {}): Promise<number> {
  const checkHealth = opts.checkHealth ?? defaultCheckHealth;
  const ensureOpencodeServer = opts.ensureOpencodeServer ?? defaultEnsureOpencodeServer;
  const spawnDaemon = opts.spawnDaemon ?? defaultSpawnDaemon;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const spawn = opts.spawn ?? defaultSpawnAttach;

  const dir = opts.dir ?? process.cwd();

  // An explicit port (flag or env) is a promise from the caller that a
  // server is already there -- verify it and fail clearly rather than
  // silently falling back to detecting/starting a different one, which
  // would attach to a server the caller didn't ask for.
  const explicitPort = opts.opencodePort ?? (process.env.MANDO_OPENCODE_PORT ? Number(process.env.MANDO_OPENCODE_PORT) : undefined);

  let opencodePort: number;
  if (explicitPort !== undefined) {
    if (!(await checkHealth(explicitPort))) {
      console.error(`mando tui: no opencode server answering on port ${explicitPort}`);
      return 1;
    }
    opencodePort = explicitPort;
  } else {
    try {
      opencodePort = await ensureOpencodeServer(dir);
    } catch (error) {
      console.error(`mando tui: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  // Same already-running-daemon guard connect() uses (see connect.ts):
  // reuse a live daemon instead of spawning a second one over it. Only
  // spawn at all when this machine has a token -- an unpaired config gets
  // a one-line hint instead, since there is nothing to spawn the daemon
  // for (defaultSpawnDaemon's re-exec would hit daemon.ts's own "no token
  // configured" guard and exit 1 anyway).
  const config = readConfig();
  if (config?.token) {
    const pid = readPidFile(defaultPidFilePath());
    const daemonAlive = pid !== null && isProcessAlive(pid);
    if (!daemonAlive) {
      spawnDaemon(opencodePort, dir);
    }
  } else {
    console.error("mando tui: not paired with a hub; run `mando connect --hub <url>` to enable remote control");
  }

  const bin = process.env.MANDO_OPENCODE_BIN ?? "opencode";
  const proc = spawn([bin, "attach", `http://127.0.0.1:${opencodePort}`, "--dir", dir]);

  // mando shares the attached child's foreground process group, so a
  // Ctrl+C in the terminal delivers SIGINT to both processes at once.
  // Without a handler here, mando's default SIGINT behavior (exit
  // immediately) would race the child's own exit and mando would never get
  // to return -- and report -- the child's real exit code. A no-op handler
  // suppresses that default for exactly the duration of the attach; it is
  // removed again right after so it doesn't linger past this call.
  const sigintHandler = (): void => {};
  process.on("SIGINT", sigintHandler);
  try {
    return await proc.exited;
  } finally {
    process.off("SIGINT", sigintHandler);
  }
}

function defaultSpawnAttach(args: string[]): SpawnedProcess {
  const proc = Bun.spawn(args, {
    stdio: ["inherit", "inherit", "inherit"],
    // Bun.spawn's `env` defaults to a snapshot of process.env taken when
    // *this* bun process launched, not the live process.env at call time
    // (same caveat as connect.ts's defaultSpawnDaemon) -- spread explicitly
    // so the attached opencode process sees any runtime overrides (e.g.
    // MANDO_OPENCODE_PASSWORD) set after this process started.
    env: { ...process.env },
  });
  return { pid: proc.pid, exited: proc.exited };
}

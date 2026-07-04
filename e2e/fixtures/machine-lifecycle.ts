// Reusable "seed a machine + bring it online via a real `mando connect`"
// logic, factored out of global-setup.ts so task 8.2 specs that need a
// *second*, test-scoped online machine (e.g. machines.spec.ts's
// online -> offline transition, which must not disturb the shared
// harness machine other spec files depend on) can reuse the exact same
// mechanism instead of re-deriving it. See task-8.1-report.md ("How a
// machine gets brought online") for why this shortcut (seed via the repo
// layer, then a real `connect()` against a pre-seeded token) was chosen
// over driving the pairing UI end-to-end.
//
// Node-safe: shells out to `bun` subprocesses for anything that touches
// Bun-only code (see global-setup.ts's top-of-file "Node vs Bun" note).
// This module itself does not import anything from apps/hub/src or
// packages/agent/src directly.
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readPidFile } from "../../packages/agent/src/daemon";
import { isMachineOnline } from "./hub-api";
import { runToCompletion, waitFor } from "./proc-utils";
import { startStubOpencode, type StubOpencode } from "./stub-opencode";

const execFile = promisify(execFileCb);

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";

export interface SeededMachine {
  machineId: string;
  token: string;
}

// Runs e2e/scripts/seed-machine.bun.ts as a real `bun` subprocess (its
// seeding logic touches Bun.password.hash transitively -- see
// fixtures/seed-machine.ts) and parses its one-line JSON stdout contract.
export async function seedMachineViaSubprocess(
  machineName: string,
  adminEmail: string,
  dbUrl: string = DB_URL,
): Promise<SeededMachine> {
  const { stdout } = await execFile(
    "bun",
    [join(REPO_ROOT, "e2e/scripts/seed-machine.bun.ts"), dbUrl, adminEmail, machineName],
    { cwd: REPO_ROOT },
  );
  return JSON.parse(stdout.trim()) as SeededMachine;
}

export interface OnlineMachine {
  machineId: string;
  pidFile: string;
  stub: StubOpencode;
  // Tears down the daemon (SIGTERM, same as global-setup.ts's teardown),
  // stops this machine's own stub opencode server, and removes the
  // isolated MANDO_CONFIG/pidfile/statefile temp dir. Safe to call more
  // than once (e.g. a test that stops the daemon mid-test to observe an
  // offline transition, then again in a `finally` as a safety net) --
  // every call after the first is a no-op.
  stop(): Promise<void>;
}

// Seeds a machine/token owned by `adminEmail`, then runs a real
// `mando connect --opencode-port <stub port>` against an isolated
// MANDO_CONFIG/PID_FILE/STATE_FILE so it never collides with the harness's
// own e2e-machine (or another test's machine) sharing the same hub.
// Because the config already has a token, connect() skips the
// pairing/approval dance and spawns the real detached daemon, which opens
// a genuine WS tunnel to the hub.
export async function bringMachineOnline(
  machineName: string,
  hubBaseUrl: string,
  adminEmail: string,
): Promise<OnlineMachine> {
  const tmpDir = mkdtempSync(join(tmpdir(), "mando-e2e-machine-"));
  const stub = await startStubOpencode();

  try {
    const seeded = await seedMachineViaSubprocess(machineName, adminEmail);

    const configPath = join(tmpDir, "mando-config.json");
    const pidFile = join(tmpDir, "mando.pid");
    const stateFile = join(tmpDir, "mando-state.json");
    const errorFile = join(tmpDir, "mando-error.json");
    writeFileSync(
      configPath,
      JSON.stringify({ hubUrl: hubBaseUrl, token: seeded.token, machineName }, null, 2),
      { mode: 0o600 },
    );

    await runToCompletion(
      "bun",
      [join(REPO_ROOT, "packages/agent/src/index.ts"), "connect", "--opencode-port", String(stub.port)],
      REPO_ROOT,
      {
        ...process.env,
        MANDO_CONFIG: configPath,
        MANDO_PID_FILE: pidFile,
        MANDO_STATE_FILE: stateFile,
        // See global-setup.ts's bringMachineOnline for why this is isolated too.
        MANDO_ERROR_FILE: errorFile,
      },
    );

    let stopped = false;
    return {
      machineId: seeded.machineId,
      pidFile,
      stub,
      async stop() {
        if (stopped) return;
        stopped = true;

        const daemonPid = readPidFile(pidFile);
        if (daemonPid !== null) {
          try {
            process.kill(daemonPid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
        await stub.stop();
        rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stub.stop();
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

// Polls GET /api/v1/machines (an authenticated fetch, not a page action --
// safe from a spec's Node-context `test.beforeAll`) until `machineName`
// reports online. Specs use this after bringMachineOnline() resolves,
// mirroring how global-setup.ts confirms the harness's own machine before
// handing control to any test.
export async function waitForMachineOnline(
  hubBaseUrl: string,
  cookie: string,
  machineName: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(
    () => isMachineOnline(hubBaseUrl, cookie, machineName),
    timeoutMs,
    `machine "${machineName}" to report online to the hub`,
  );
}

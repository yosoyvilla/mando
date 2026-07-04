// Playwright globalSetup for the GATED real-opencode handoff test
// (playwright.real.config.ts). It is a deliberate parallel of
// global-setup.ts, with exactly one substitution: instead of the
// in-process stub opencode, it boots a REAL `opencode serve` and points
// the agent daemon at that port. Everything else -- Postgres, the real hub
// entrypoint, seeding a machine and bringing it online via a real
// `mando connect` -- is identical, because the whole value of this test is
// swapping ONLY the opencode implementation and proving the rest of the
// stack behaves the same against the genuine server.
//
// It also does the one thing the default harness never needs: before the
// machine comes online, it creates a session by calling the real opencode
// API DIRECTLY (RealOpencode.createSession) -- standing in for a user who
// started an opencode session in their terminal. The handoff test then has
// to rediscover that exact session id through the hub proxy.
//
// The rendezvous with the spec is a JSON file (REAL_HANDOFF_STATE_FILE),
// not env vars: Playwright's globalSetup runs in a different process than
// the test workers, and env set here does not reliably reach them.
//
// Node vs Bun: same as global-setup.ts -- this file and its imports stay
// Node-portable; anything Bun-only is shelled out to a real `bun`
// subprocess (the hub, `mando connect`, seed-machine.bun.ts).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import { getDb } from "../apps/hub/src/db/client";
import { readPidFile } from "../packages/agent/src/daemon";
import { isMachineOnline, loginForCookie } from "./fixtures/hub-api";
import { DB_URL, REPO_ROOT, seedMachineViaSubprocess } from "./fixtures/machine-lifecycle";
import { runToCompletion, waitFor, waitForExit } from "./fixtures/proc-utils";
import { startRealOpencode, REAL_HANDOFF_STATE_FILE, type RealOpencode } from "./fixtures/real-opencode";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, HUB_PORT } from "./harness-config";

// A dedicated machine name so this gated run never collides with (or gets
// confused for) the default suite's "e2e-machine", even if both DBs are
// the same local Postgres instance across runs.
const REAL_MACHINE_NAME = "real-oc-machine";

const USING_CI_DATABASE = Boolean(process.env.TEST_DATABASE_URL);

async function ensurePostgres(): Promise<void> {
  if (!USING_CI_DATABASE) {
    await runToCompletion(
      "docker",
      ["compose", "-f", join(REPO_ROOT, "deploy/docker-compose.yml"), "up", "-d", "postgres"],
      REPO_ROOT,
    );
  }
  await waitFor(
    async () => {
      await getDb(DB_URL)`select 1`;
      return true;
    },
    30_000,
    "postgres to accept connections",
  );
}

// Same rationale as global-setup.ts's pruneStaleHarnessMachine: keep at
// most one row for this harness's machine name so repeated local runs
// don't accumulate duplicates.
async function pruneStaleMachine(): Promise<void> {
  await getDb(DB_URL)`delete from machines where name = ${REAL_MACHINE_NAME}`;
}

function startHub(): ChildProcess {
  return spawn("bun", [join(REPO_ROOT, "apps/hub/src/index.ts")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      COOKIE_SECRET: "e2e-test-cookie-secret-at-least-32-characters",
      PUBLIC_URL: HUB_BASE_URL,
      PORT: String(HUB_PORT),
      MANDO_ADMIN_EMAIL: ADMIN_EMAIL,
      MANDO_ADMIN_PASSWORD: ADMIN_PASSWORD,
      MANDO_WEB_DIR: join(REPO_ROOT, "apps/web/dist"),
      MANDO_RATE_LIMIT_LOGIN_MAX: "1000",
      MANDO_RATE_LIMIT_PAIRING_MAX: "1000",
      MANDO_RATE_LIMIT_WS_AGENT_MAX: "1000",
    },
  });
}

async function waitForHubHealthy(): Promise<void> {
  await waitFor(
    async () => {
      const res = await fetch(`${HUB_BASE_URL}/healthz`);
      return res.ok;
    },
    20_000,
    "hub GET /healthz",
  );
}

// Seeds a machine/token owned by the admin, then runs a real
// `mando connect --opencode-port <REAL opencode port>` against an isolated
// MANDO_CONFIG. The only difference from global-setup.ts is the port it
// forwards to -- a genuine `opencode serve`, not the stub. Returns the
// machineId and the daemon pidfile so teardown can stop it.
async function bringMachineOnline(
  opencodePort: number,
  tmpDir: string,
): Promise<{ machineId: string; pidFile: string }> {
  const seeded = await seedMachineViaSubprocess(REAL_MACHINE_NAME, ADMIN_EMAIL);

  const configPath = join(tmpDir, "mando-config.json");
  const pidFile = join(tmpDir, "mando.pid");
  const stateFile = join(tmpDir, "mando-state.json");
  const errorFile = join(tmpDir, "mando-error.json");
  writeFileSync(
    configPath,
    JSON.stringify({ hubUrl: HUB_BASE_URL, token: seeded.token, machineName: REAL_MACHINE_NAME }, null, 2),
    { mode: 0o600 },
  );

  await runToCompletion(
    "bun",
    [join(REPO_ROOT, "packages/agent/src/index.ts"), "connect", "--opencode-port", String(opencodePort)],
    REPO_ROOT,
    {
      ...process.env,
      MANDO_CONFIG: configPath,
      MANDO_PID_FILE: pidFile,
      MANDO_STATE_FILE: stateFile,
      MANDO_ERROR_FILE: errorFile,
    },
  );

  return { machineId: seeded.machineId, pidFile };
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const tmpDir = mkdtempSync(join(tmpdir(), "mando-e2e-real-"));

  await ensurePostgres();

  // Start the hub first: its startup path runs the DB migrations, so the
  // `machines` table exists before pruneStaleMachine() touches it. On a
  // fresh CI database the old order (prune before hub start) threw
  // `relation "machines" does not exist`.
  const hubProcess = startHub();
  await waitForHubHealthy();
  await pruneStaleMachine();

  let opencode: RealOpencode | null = null;
  try {
    opencode = await startRealOpencode();

    // The "terminal" client: create a session by hitting real opencode
    // directly, BEFORE the machine is online, so the handoff test proves
    // rediscovery of a pre-existing session rather than one it made itself.
    const terminalSessionId = await opencode.createSession();

    const { machineId, pidFile } = await bringMachineOnline(opencode.port, tmpDir);

    const cookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitFor(
      () => isMachineOnline(HUB_BASE_URL, cookie, REAL_MACHINE_NAME),
      15_000,
      "seeded machine to report online to the hub",
    );

    writeFileSync(
      REAL_HANDOFF_STATE_FILE,
      JSON.stringify(
        {
          hubBaseUrl: HUB_BASE_URL,
          machineId,
          machineName: REAL_MACHINE_NAME,
          opencodePort: opencode.port,
          terminalSessionId,
        },
        null,
        2,
      ),
    );
    console.error(
      `[real-handoff] terminal session ${terminalSessionId} created on real opencode :${opencode.port}, machine ${machineId} online`,
    );

    const opencodeRef = opencode;

    return async function globalTeardown(): Promise<void> {
      const daemonPid = readPidFile(pidFile);
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }

      await opencodeRef.stop();

      hubProcess.kill("SIGTERM");
      await waitForExit(hubProcess).catch(() => {});

      await getDb(DB_URL).end({ timeout: 5 });
      if (existsSync(REAL_HANDOFF_STATE_FILE)) rmSync(REAL_HANDOFF_STATE_FILE, { force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    };
  } catch (error) {
    await opencode?.stop();
    hubProcess.kill("SIGTERM");
    await waitForExit(hubProcess).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

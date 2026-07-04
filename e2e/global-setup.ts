// Playwright globalSetup for the e2e harness. What it does, in order:
//
//   (a) Ensures Postgres is reachable. If TEST_DATABASE_URL is set (CI
//       provides it as a service container) that URL is used as-is and
//       docker compose is never touched. Otherwise it runs
//       `docker compose -f deploy/docker-compose.yml up -d postgres`
//       (idempotent -- a no-op if it's already running from local dev)
//       and waits for it to accept connections.
//   (b) Builds the web SPA (`bun run build --filter @mando/web`) if
//       apps/web/dist/index.html doesn't already exist.
//   (c) Starts the real hub entry point, apps/hub/src/index.ts, as a `bun`
//       child process with a test env -- this is the harness's coverage of
//       the hub's actual startup path (migrations + admin bootstrap +
//       Bun.serve), not just buildApp() in-process. Waits for GET
//       /healthz.
//   (d) Starts the stub opencode HTTP server (fixtures/stub-opencode.ts,
//       in-process) on an ephemeral port.
//   (e) Seeds a machine + token owned by the bootstrapped admin (via a
//       spawned `bun` one-shot script, see scripts/seed-machine.bun.ts),
//       writes an isolated MANDO_CONFIG pointing at the hub with that
//       token, and runs a real `mando connect --opencode-port <stub port>`
//       against it. Since the token already exists, connect() skips
//       pairing entirely and just spawns the real detached daemon, which
//       opens a real WS tunnel to the hub and proxies to the stub. Waits
//       (via an admin-authenticated GET /api/v1/machines poll) until the
//       hub reports it online.
//
// *** Node vs Bun ***
// Playwright's test runner loads config/globalSetup/spec files -- and
// everything they import -- under a real Node.js process, even when the
// whole suite is launched via `bunx playwright test` (confirmed by
// spawning a probe globalSetup that logged `typeof Bun` -> "undefined" and
// `process.execPath` -> a `node` binary). `bunx` only affects which
// runtime executes the `playwright` CLI's own entry script; Playwright's
// internal dispatcher that calls globalSetup does not inherit that
// choice. Practical consequence: this file and fixtures/stub-opencode.ts
// use only Node-portable APIs (node:http, node:child_process, global
// fetch/crypto) -- no Bun.serve/Bun.spawn/Bun.password. Anything that
// genuinely needs Bun (the hub, the agent CLI, hashing a token with
// Bun.password.hash for seeding) is shelled out to as a real `bun`
// subprocess instead, via child_process -- those subprocesses run under
// the actual `bun` binary regardless of what launched *this* process.
//
// Per Playwright's documented pattern, this function returns a teardown
// closure instead of relying on a separate global-teardown.ts file -- that
// keeps the hub/stub/daemon process handles in the same closure they were
// created in, rather than needing to serialize them across a process
// boundary.
//
// What each spec sets up for itself (not this file's job): logging in,
// selecting/creating a session, sending prompts -- see task 8.2.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { FullConfig } from "@playwright/test";
import { getDb } from "../apps/hub/src/db/client";
import { readPidFile } from "../packages/agent/src/daemon";
import { startStubOpencode, type StubOpencode } from "./fixtures/stub-opencode";
import { isMachineOnline, loginForCookie } from "./fixtures/hub-api";
import { DB_URL, REPO_ROOT, seedMachineViaSubprocess } from "./fixtures/machine-lifecycle";
import { runToCompletion, waitFor, waitForExit } from "./fixtures/proc-utils";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, HUB_PORT, MACHINE_NAME } from "./harness-config";

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

// Postgres data is deliberately left running between local runs (see
// "Teardown: what stops, what doesn't" below), but seedMachineViaSubprocess
// always inserts a fresh row rather than reusing one -- flagged as a
// follow-up in task-8.1-report.md ("DB growth across local runs"). Left
// unaddressed, repeated local iteration accumulates same-named
// "e2e-machine" rows, and once more than one exists, task 8.2's specs that
// locate it by name (e.g. machines.spec.ts's online-badge assertion) hit a
// Playwright strict-mode violation instead of a single match. Pruning the
// harness's own previous rows before reseeding keeps exactly one around
// per run without touching anything a spec created for itself (those use
// randomized names, not MACHINE_NAME).
async function pruneStaleHarnessMachine(): Promise<void> {
  await getDb(DB_URL)`delete from machines where name = ${MACHINE_NAME}`;
}

async function ensureWebBuild(): Promise<void> {
  const indexHtml = join(REPO_ROOT, "apps/web/dist/index.html");
  if (existsSync(indexHtml)) return;
  await runToCompletion("bun", ["run", "build", "--filter", "@mando/web"], REPO_ROOT);
  if (!existsSync(indexHtml)) {
    throw new Error("apps/web/dist/index.html still missing after `bun run build --filter @mando/web`");
  }
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
      // The whole suite runs single-worker, serially, against one hub, and
      // every spec's login()/pairing call shares the same client IP (see
      // middleware/rate-limit.ts's clientIp() -- there's no proxy in front
      // of this harness to set X-Forwarded-For, so it falls back to the
      // real loopback connection address). That's legitimate traffic from
      // one test client, not a flood, but it would still trip the
      // production defaults (10 logins/min) partway through a run. Raise
      // the maxes for this harness only -- production keeps the tight
      // defaults.
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

// Seeds a machine/token owned by the bootstrapped admin, then runs a real
// `mando connect --opencode-port <stub port>` against an isolated
// MANDO_CONFIG. Because the config already has a token, connect() skips
// the pairing/approval dance entirely (see packages/agent/src/connect.ts)
// and just spawns the real detached daemon. Returns the pidfile path so
// teardown can find and stop that daemon.
async function bringMachineOnline(stubPort: number, tmpDir: string): Promise<{ pidFile: string }> {
  const seeded = await seedMachineViaSubprocess(MACHINE_NAME, ADMIN_EMAIL);

  const configPath = join(tmpDir, "mando-config.json");
  const pidFile = join(tmpDir, "mando.pid");
  const stateFile = join(tmpDir, "mando-state.json");
  writeFileSync(
    configPath,
    JSON.stringify({ hubUrl: HUB_BASE_URL, token: seeded.token, machineName: MACHINE_NAME }, null, 2),
    { mode: 0o600 },
  );

  await runToCompletion(
    "bun",
    [join(REPO_ROOT, "packages/agent/src/index.ts"), "connect", "--opencode-port", String(stubPort)],
    REPO_ROOT,
    {
      ...process.env,
      MANDO_CONFIG: configPath,
      MANDO_PID_FILE: pidFile,
      MANDO_STATE_FILE: stateFile,
    },
  );

  return { pidFile };
}

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  const tmpDir = mkdtempSync(join(tmpdir(), "mando-e2e-"));

  await ensurePostgres();
  await pruneStaleHarnessMachine();
  await ensureWebBuild();

  const hubProcess = startHub();
  await waitForHubHealthy();

  let stub: StubOpencode | null = null;
  try {
    stub = await startStubOpencode();
    const { pidFile } = await bringMachineOnline(stub.port, tmpDir);

    const cookie = await loginForCookie(HUB_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD);
    await waitFor(
      () => isMachineOnline(HUB_BASE_URL, cookie, MACHINE_NAME),
      15_000,
      "seeded machine to report online to the hub",
    );

    const stubRef = stub;

    return async function globalTeardown(): Promise<void> {
      const daemonPid = readPidFile(pidFile);
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }

      await stubRef.stop();

      hubProcess.kill("SIGTERM");
      await waitForExit(hubProcess).catch(() => {});

      // Postgres is intentionally left running -- see task-8.1-report.md
      // ("Teardown: what stops, what doesn't"). Its compose volume
      // persists data across restarts regardless, so stopping it here
      // would only slow down the next local run for no correctness gain.

      await getDb(DB_URL).end({ timeout: 5 });
      rmSync(tmpDir, { recursive: true, force: true });
    };
  } catch (error) {
    // Setup failed partway through -- clean up whatever did start before
    // rethrowing, since Playwright won't call our (never-returned)
    // teardown closure in this path.
    await stub?.stop();
    hubProcess.kill("SIGTERM");
    await waitForExit(hubProcess).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

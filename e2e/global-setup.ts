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
import { execFile as execFileCb, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import { getDb } from "../apps/hub/src/db/client";
import { readPidFile } from "../packages/agent/src/daemon";
import { startStubOpencode, type StubOpencode } from "./fixtures/stub-opencode";
import { ADMIN_EMAIL, ADMIN_PASSWORD, HUB_BASE_URL, HUB_PORT, MACHINE_NAME } from "./harness-config";

const execFile = promisify(execFileCb);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://mando:mando@localhost:5433/mando";
const USING_CI_DATABASE = Boolean(process.env.TEST_DATABASE_URL);
const SESSION_COOKIE_NAME = "mando_sess";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

async function runToCompletion(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", env: env ?? process.env });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`command failed (exit ${code}): ${cmd} ${args.join(" ")}`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function ensurePostgres(): Promise<void> {
  if (!USING_CI_DATABASE) {
    await runToCompletion("docker", [
      "compose",
      "-f",
      join(REPO_ROOT, "deploy/docker-compose.yml"),
      "up",
      "-d",
      "postgres",
    ]);
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

async function ensureWebBuild(): Promise<void> {
  const indexHtml = join(REPO_ROOT, "apps/web/dist/index.html");
  if (existsSync(indexHtml)) return;
  await runToCompletion("bun", ["run", "build", "--filter", "@mando/web"]);
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
      COOKIE_SECRET: "e2e-test-cookie-secret",
      PUBLIC_URL: HUB_BASE_URL,
      PORT: String(HUB_PORT),
      MANDO_ADMIN_EMAIL: ADMIN_EMAIL,
      MANDO_ADMIN_PASSWORD: ADMIN_PASSWORD,
      MANDO_WEB_DIR: join(REPO_ROOT, "apps/web/dist"),
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

function parseSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return match ? `${SESSION_COOKIE_NAME}=${match[1]}` : null;
}

async function loginAsAdmin(): Promise<string> {
  const res = await fetch(`${HUB_BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`admin login failed with status ${res.status}`);
  const cookie = parseSessionCookie(res.headers.get("set-cookie"));
  if (!cookie) throw new Error("admin login succeeded but response carried no session cookie");
  return cookie;
}

async function isSeededMachineOnline(cookie: string): Promise<boolean> {
  const res = await fetch(`${HUB_BASE_URL}/api/v1/machines`, { headers: { cookie } });
  if (!res.ok) return false;
  const body = (await res.json()) as { machines: Array<{ name: string; online: boolean }> };
  return body.machines.some((machine) => machine.name === MACHINE_NAME && machine.online);
}

interface SeededMachine {
  machineId: string;
  token: string;
}

// Runs scripts/seed-machine.bun.ts as a real `bun` subprocess (needed
// because the seeding logic touches Bun.password.hash transitively -- see
// this file's top-of-file "Node vs Bun" note) and parses its one-line JSON
// stdout contract.
async function seedMachineViaSubprocess(): Promise<SeededMachine> {
  const { stdout } = await execFile(
    "bun",
    [join(REPO_ROOT, "e2e/scripts/seed-machine.bun.ts"), DB_URL, ADMIN_EMAIL, MACHINE_NAME],
    { cwd: REPO_ROOT },
  );
  return JSON.parse(stdout.trim()) as SeededMachine;
}

// Seeds a machine/token owned by the bootstrapped admin, then runs a real
// `mando connect --opencode-port <stub port>` against an isolated
// MANDO_CONFIG. Because the config already has a token, connect() skips
// the pairing/approval dance entirely (see packages/agent/src/connect.ts)
// and just spawns the real detached daemon. Returns the pidfile path so
// teardown can find and stop that daemon.
async function bringMachineOnline(stubPort: number, tmpDir: string): Promise<{ pidFile: string }> {
  const seeded = await seedMachineViaSubprocess();

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
  await ensureWebBuild();

  const hubProcess = startHub();
  await waitForHubHealthy();

  let stub: StubOpencode | null = null;
  try {
    stub = await startStubOpencode();
    const { pidFile } = await bringMachineOnline(stub.port, tmpDir);

    const cookie = await loginAsAdmin();
    await waitFor(
      () => isSeededMachineOnline(cookie),
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

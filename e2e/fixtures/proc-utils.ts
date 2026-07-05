// Small Node-portable process/polling helpers shared by global-setup.ts and
// any spec-level fixture that needs to spawn/wait-for its own subprocess
// (e.g. fixtures/spawn-machine.ts, task 8.2). Pulled out of global-setup.ts
// rather than duplicated -- see task-8.2-report.md.
import { spawn, type ChildProcess } from "node:child_process";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? -1));
  });
}

// Teardown-grade kill: SIGTERM, bounded wait, SIGKILL fallback, bounded
// wait, then give up and return either way. Plain `kill("SIGTERM")` +
// `waitForExit` is NOT safe in teardown: a real `opencode serve` on a CI
// runner was observed to ignore SIGTERM entirely, which left globalSetup's
// returned teardown awaiting an exit that never came -- every test had
// already passed, but the job hung for 20+ minutes (until manual
// cancellation; the runner's own cleanup then found opencode and the hub
// still alive as orphans). Teardown must never be able to hang the run.
export async function killAndWait(child: ChildProcess, termTimeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child).catch(() => -1);
  const timedOut = Symbol("timeout");
  child.kill("SIGTERM");
  if ((await Promise.race([exited, sleep(termTimeoutMs).then(() => timedOut)])) !== timedOut) return;
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000)]);
}

export async function runToCompletion(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", env: env ?? process.env });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`command failed (exit ${code}): ${cmd} ${args.join(" ")}`);
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

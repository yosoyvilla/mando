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

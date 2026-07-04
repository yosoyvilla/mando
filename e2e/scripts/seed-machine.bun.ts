// Standalone Bun entrypoint for seeding a machine + token. global-setup.ts
// runs under Playwright's Node-based test runner (see task-8.1-report.md,
// "Node vs Bun"), so it cannot import fixtures/seed-machine.ts directly --
// that module transitively pulls in apps/hub/src/auth/password.ts, which
// calls `Bun.password.hash(...)` at module-eval time. Spawning this file
// directly via the `bun` binary (child_process.spawn("bun", [...]) from
// global-setup.ts) sidesteps that: this process is genuinely Bun,
// regardless of what launched it.
//
// Contract with global-setup.ts: prints exactly one line of JSON
// (`{"machineId":"...","token":"..."}`) to stdout and nothing else, then
// exits 0. Any diagnostic output goes to stderr instead, so the caller's
// stdout parse never has to guess which line is the payload.
import { seedMachine } from "../fixtures/seed-machine";

async function main(): Promise<void> {
  const [databaseUrl, adminEmail, machineName] = process.argv.slice(2);
  if (!databaseUrl || !adminEmail || !machineName) {
    console.error("usage: bun seed-machine.bun.ts <databaseUrl> <adminEmail> <machineName>");
    process.exit(1);
  }

  const seeded = await seedMachine(databaseUrl, adminEmail, machineName);
  process.stdout.write(JSON.stringify(seeded));
  // The `postgres` connection pool getDb() opened would otherwise keep this
  // process's event loop alive indefinitely -- this is a one-shot script,
  // not a long-lived server, so exit explicitly once the payload is
  // flushed.
  process.exit(0);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

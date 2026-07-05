// Shared constants between playwright.config.ts and global-setup.ts so the
// port/credentials the hub is started with and the port/credentials tests
// run against can never drift apart.
export const HUB_PORT = 8090;
export const HUB_BASE_URL = `http://localhost:${HUB_PORT}`;

// Admin bootstrapped via MANDO_ADMIN_EMAIL/MANDO_ADMIN_PASSWORD when the
// hub child process starts (see apps/hub/src/bootstrap.ts) -- global-setup
// logs in as this user to seed/verify the e2e machine, and specs (task 8.2)
// use the same credentials to drive the real login form.
export const ADMIN_EMAIL = "e2e-admin@mando.test";
export const ADMIN_PASSWORD = "e2e-test-password-123";

// Name of the machine seeded (see fixtures/seed-machine.ts) and connected
// (via a real `mando connect` against a pre-seeded token) in global-setup,
// so at least one machine is ONLINE for specs that need one.
export const MACHINE_NAME = "e2e-machine";

// global-setup.ts writes the stub opencode server's ephemeral port here so
// spec files (running in the worker process Playwright forks after
// globalSetup completes -- which inherits `process.env` as of that point)
// can reach it directly for test-only affordances like
// fixtures/stub-control.ts's `enqueueStubPermission`, without the hub's
// per-machine proxy in the way.
export const STUB_PORT_ENV = "MANDO_E2E_STUB_PORT";

import { defineConfig, devices } from "@playwright/test";
import { HUB_BASE_URL } from "./harness-config";

// Run via `bunx playwright test` from this directory (see e2e/package.json
// and task-8.1-report.md) -- global-setup.ts uses Bun-only APIs
// (Bun.serve, Bun.spawn, Bun.password via relative imports into
// apps/hub/src) and relies on the whole run happening under the Bun
// runtime, not Node.
export default defineConfig({
  testDir: "./tests",
  // The real-opencode handoff test requires a live `opencode serve` binary
  // and its own global-setup (see playwright.real.config.ts). Keep it out
  // of the default suite so `bunx playwright test` stays fast, hermetic,
  // and independent of whether opencode is installed.
  testIgnore: "**/real-opencode-handoff.spec.ts",
  timeout: 30_000,
  fullyParallel: false,
  // The harness boots exactly one hub + one seeded machine; concurrent
  // workers would either race on the same session state or need per-worker
  // stacks, neither of which this task needs yet.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: HUB_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

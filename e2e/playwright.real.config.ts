import { defineConfig, devices } from "@playwright/test";
import { HUB_BASE_URL } from "./harness-config";

// GATED config for the real-opencode handoff tests. The DEFAULT
// `bunx playwright test` uses playwright.config.ts, which ignores
// **/real-opencode-*.spec.ts (see its testIgnore) -- so the 16 stub
// tests stay fast and deterministic and never require the opencode binary.
// This config runs ONLY the real-opencode specs (the API-level handoff spec
// and the browser-driven handoff spec), against a real `opencode serve`
// booted by global-setup-real.ts:
//
//   cd e2e && bunx playwright test --config playwright.real.config.ts
//
// Same Bun-runtime requirement as the default config (globalSetup shells
// out to `bun` for the hub/agent/seed subprocesses), hence `bunx`.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/real-opencode-*.spec.ts",
  // A little longer than the default: booting a real opencode server and
  // waiting for the async user-message recording is slower than the stub.
  // Also covers a real server occasionally taking a while to admit a NEW
  // message into a session whose first turn (from the terminal's own
  // `opencode run`) is still in flight -- a real model call, even a fast
  // provider-auth failure, is not instant.
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./global-setup-real.ts",
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

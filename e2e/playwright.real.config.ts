import { defineConfig, devices } from "@playwright/test";
import { HUB_BASE_URL } from "./harness-config";

// GATED config for the real-opencode handoff test. The DEFAULT
// `bunx playwright test` uses playwright.config.ts, which ignores
// real-opencode-handoff.spec.ts (see its testIgnore) -- so the 16 stub
// tests stay fast and deterministic and never require the opencode binary.
// This config runs ONLY that one spec, against a real `opencode serve`
// booted by global-setup-real.ts:
//
//   cd e2e && bunx playwright test --config playwright.real.config.ts
//
// Same Bun-runtime requirement as the default config (globalSetup shells
// out to `bun` for the hub/agent/seed subprocesses), hence `bunx`.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/real-opencode-handoff.spec.ts",
  // A little longer than the default: booting a real opencode server and
  // waiting for the async user-message recording is slower than the stub.
  timeout: 45_000,
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

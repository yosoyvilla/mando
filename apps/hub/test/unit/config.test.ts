import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";

test("loadConfig requires DATABASE_URL", () => {
  expect(() => loadConfig({ COOKIE_SECRET: "x", PUBLIC_URL: "http://x" })).toThrow();
});

test("loadConfig defaults port to 8080", () => {
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
  });
  expect(c.port).toBe(8080);
});

test("loadConfig rejects a COOKIE_SECRET shorter than 32 characters", () => {
  expect(() =>
    loadConfig({
      DATABASE_URL: "postgres://u:p@localhost/db",
      COOKIE_SECRET: "s".repeat(31),
      PUBLIC_URL: "http://x",
    }),
  ).toThrow();
});

test("loadConfig leaves rate limit maxes undefined by default and picks up MANDO_RATE_LIMIT_* overrides", () => {
  const withoutOverrides = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
  });
  expect(withoutOverrides.rateLimitLoginMax).toBeUndefined();
  expect(withoutOverrides.rateLimitPairingMax).toBeUndefined();
  expect(withoutOverrides.rateLimitWsAgentMax).toBeUndefined();

  const withOverrides = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
    MANDO_RATE_LIMIT_LOGIN_MAX: "1000",
    MANDO_RATE_LIMIT_PAIRING_MAX: "2000",
    MANDO_RATE_LIMIT_WS_AGENT_MAX: "3000",
  });
  expect(withOverrides.rateLimitLoginMax).toBe(1000);
  expect(withOverrides.rateLimitPairingMax).toBe(2000);
  expect(withOverrides.rateLimitWsAgentMax).toBe(3000);
});

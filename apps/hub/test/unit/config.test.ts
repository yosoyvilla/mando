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

test("loadConfig leaves encryptionKey undefined when MANDO_ENCRYPTION_KEY is unset", () => {
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
  });
  expect(c.encryptionKey).toBeUndefined();
});

test("loadConfig decodes a 64-char hex MANDO_ENCRYPTION_KEY into a 32-byte key", () => {
  const hexKey = "ab".repeat(32);
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
    MANDO_ENCRYPTION_KEY: hexKey,
  });
  expect(c.encryptionKey).toBeInstanceOf(Buffer);
  expect(c.encryptionKey?.length).toBe(32);
  expect(c.encryptionKey?.toString("hex")).toBe(hexKey);
});

test("loadConfig decodes a base64 MANDO_ENCRYPTION_KEY into a 32-byte key", () => {
  const raw = Buffer.alloc(32, 7);
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s".repeat(32),
    PUBLIC_URL: "http://x",
    MANDO_ENCRYPTION_KEY: raw.toString("base64"),
  });
  expect(c.encryptionKey?.equals(raw)).toBe(true);
});

test("loadConfig hard-fails startup when MANDO_ENCRYPTION_KEY does not decode to exactly 32 bytes", () => {
  expect(() =>
    loadConfig({
      DATABASE_URL: "postgres://u:p@localhost/db",
      COOKIE_SECRET: "s".repeat(32),
      PUBLIC_URL: "http://x",
      // 16 bytes hex-encoded, not 32.
      MANDO_ENCRYPTION_KEY: "ab".repeat(16),
    }),
  ).toThrow();
});

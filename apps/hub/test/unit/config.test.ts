import { test, expect } from "bun:test";
import { loadConfig } from "../../src/config";

test("loadConfig requires DATABASE_URL", () => {
  expect(() => loadConfig({ COOKIE_SECRET: "x", PUBLIC_URL: "http://x" })).toThrow();
});

test("loadConfig defaults port to 8080", () => {
  const c = loadConfig({
    DATABASE_URL: "postgres://u:p@localhost/db",
    COOKIE_SECRET: "s",
    PUBLIC_URL: "http://x",
  });
  expect(c.port).toBe(8080);
});

import { test, expect } from "bun:test";
import { hashSecret, verifySecret } from "../../src/auth/password";

test("hash verifies", async () => {
  const h = await hashSecret("hunter2horse");
  expect(await verifySecret("hunter2horse", h)).toBe(true);
  expect(await verifySecret("wrong", h)).toBe(false);
});

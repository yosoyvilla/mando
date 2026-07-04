import { test, expect } from "bun:test";
import { hashSecret, verifySecret } from "../../src/auth/password";

test("hash verifies", async () => {
  const h = await hashSecret("hunter2horse");
  expect(await verifySecret("hunter2horse", h)).toBe(true);
  expect(await verifySecret("wrong", h)).toBe(false);
});

test("hashSecret encodes the pinned argon2id params in the hash string", async () => {
  const h = await hashSecret("hunter2horse");
  expect(h).toStartWith("$argon2id$");
  expect(h).toContain("m=19456");
  expect(h).toContain("t=2");
});

// argon2's encoded hash embeds its own params (see verifySecret's comment in
// auth/password.ts), so a hash made under different -- e.g. Bun's old,
// unpinned -- params must still verify correctly today. Bun.password.hash is
// called directly here (bypassing hashSecret's now-pinned ARGON2ID_PARAMS)
// to stand in for a hash created before that pin existed.
test("a hash made with different (pre-pin) argon2id params still verifies", async () => {
  const legacyHash = await Bun.password.hash("hunter2horse", { algorithm: "argon2id" });
  expect(legacyHash).not.toContain("m=19456");
  expect(await verifySecret("hunter2horse", legacyHash)).toBe(true);
  expect(await verifySecret("wrong", legacyHash)).toBe(false);
});

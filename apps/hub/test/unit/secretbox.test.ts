import { test, expect } from "bun:test";
import {
  encryptSecret,
  decryptSecret,
  isEncryptionConfigured,
  SecretboxError,
} from "../../src/crypto/secretbox";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

test("encryptSecret then decryptSecret round-trips the original plaintext", () => {
  const blob = encryptSecret("sk-super-secret-value", { encryptionKey: KEY_A });
  expect(decryptSecret(blob, { encryptionKey: KEY_A })).toBe("sk-super-secret-value");
});

test("decryptSecret rejects a blob whose ciphertext or tag was tampered with", () => {
  const blob = encryptSecret("sk-super-secret-value", { encryptionKey: KEY_A });
  const raw = Buffer.from(blob, "base64");
  // Flip a byte inside the ciphertext (after iv[12] + authTag[16]).
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
  const tampered = raw.toString("base64");

  expect(() => decryptSecret(tampered, { encryptionKey: KEY_A })).toThrow(SecretboxError);
});

test("decryptSecret fails when decrypted with the wrong key", () => {
  const blob = encryptSecret("sk-super-secret-value", { encryptionKey: KEY_A });
  expect(() => decryptSecret(blob, { encryptionKey: KEY_B })).toThrow(SecretboxError);
});

test("encryptSecret and decryptSecret throw a typed not_configured error when no key is set", () => {
  expect(() => encryptSecret("plain", { encryptionKey: undefined })).toThrow(SecretboxError);
  expect(() => decryptSecret("blob", { encryptionKey: undefined })).toThrow(SecretboxError);

  try {
    encryptSecret("plain", { encryptionKey: undefined });
    throw new Error("expected encryptSecret to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(SecretboxError);
    expect((err as SecretboxError).reason).toBe("not_configured");
  }
});

test("isEncryptionConfigured reflects whether a key is present", () => {
  expect(isEncryptionConfigured({ encryptionKey: KEY_A })).toBe(true);
  expect(isEncryptionConfigured({ encryptionKey: undefined })).toBe(false);
});

test("encryptSecret produces a different ciphertext each call for the same plaintext (random IV)", () => {
  const blobA = encryptSecret("same-plaintext", { encryptionKey: KEY_A });
  const blobB = encryptSecret("same-plaintext", { encryptionKey: KEY_A });
  expect(blobA).not.toBe(blobB);
  // Decoded IV (first 12 bytes) must differ too, not just incidental base64 framing.
  const ivA = Buffer.from(blobA, "base64").subarray(0, 12);
  const ivB = Buffer.from(blobB, "base64").subarray(0, 12);
  expect(ivA.equals(ivB)).toBe(false);
});

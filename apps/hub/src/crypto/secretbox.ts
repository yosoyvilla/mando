import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "../config";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export type SecretboxErrorReason = "not_configured" | "decrypt_failed";

export class SecretboxError extends Error {
  readonly reason: SecretboxErrorReason;

  constructor(reason: SecretboxErrorReason) {
    super(
      reason === "not_configured"
        ? "MANDO_ENCRYPTION_KEY is not configured -- the provider/images feature is disabled"
        : "failed to decrypt secret (wrong key or corrupted/tampered ciphertext)",
    );
    this.name = "SecretboxError";
    this.reason = reason;
  }
}

type KeyConfig = Pick<Config, "encryptionKey">;

function requireKey(config: KeyConfig): Buffer {
  if (!config.encryptionKey) throw new SecretboxError("not_configured");
  return config.encryptionKey;
}

export function isEncryptionConfigured(config: KeyConfig): boolean {
  return config.encryptionKey !== undefined;
}

// Stores iv(12) || authTag(16) || ciphertext as a single base64 blob, ready
// for a text column. A fresh, cryptographically random IV is generated on
// every call (never derived or reused) -- AES-GCM's confidentiality and
// integrity guarantees both break down if an IV is ever reused under the
// same key, so this must never become a deterministic/derived value even
// for callers that would prefer stable ciphertext.
export function encryptSecret(plain: string, config: KeyConfig): string {
  const key = requireKey(config);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

// Inverse of encryptSecret. Any failure -- a too-short blob, a wrong key, or
// a tampered ciphertext/auth tag -- collapses into the same SecretboxError
// rather than leaking which specific check failed to a caller.
export function decryptSecret(blob: string, config: KeyConfig): string {
  const key = requireKey(config);
  const raw = Buffer.from(blob, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new SecretboxError("decrypt_failed");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // setAuthTag/final() throws on tamper or wrong key -- node:crypto's
    // exact error text isn't part of any stable contract, so it's not
    // surfaced to callers.
    throw new SecretboxError("decrypt_failed");
  }
}

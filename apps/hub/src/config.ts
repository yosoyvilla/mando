import { z } from "zod";

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  // Reserved for future cookie signing -- sessions are currently opaque,
  // server-side tokens (see auth/session.ts), so this isn't used to sign or
  // encrypt anything yet. Still enforced at a real minimum length so a weak
  // value doesn't silently ship into whatever consumes it once that lands.
  COOKIE_SECRET: z.string().min(32),
  PUBLIC_URL: z.url(),
  MANDO_ADMIN_EMAIL: z.email().optional(),
  MANDO_ADMIN_PASSWORD: z.string().min(8).optional(),
  // Overrides for middleware/rate-limit.ts's DEFAULT_RATE_LIMITS maxes,
  // without redeploying code, for operators who find the defaults too
  // tight (e.g. many users behind one NAT'd office IP) or -- as the e2e
  // harness does (see e2e/global-setup.ts) -- a single test client that
  // legitimately logs in far more than 10 times/minute against one hub.
  // Window sizes stay fixed; only the request budget per window is tunable.
  MANDO_RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().optional(),
  MANDO_RATE_LIMIT_PAIRING_MAX: z.coerce.number().int().positive().optional(),
  MANDO_RATE_LIMIT_WS_AGENT_MAX: z.coerce.number().int().positive().optional(),
  // Overrides DEFAULT_RATE_LIMITS.images's max -- the images generate/edit
  // endpoints call the user's own (potentially costly) provider, so this
  // follows the exact same override pattern as MANDO_RATE_LIMIT_LOGIN_MAX
  // above rather than introducing a new shape.
  MANDO_RATE_LIMIT_IMAGES_MAX: z.coerce.number().int().positive().optional(),
  // Overrides DEFAULT_RATE_LIMITS.chat's max -- POST .../messages calls the
  // user's own (potentially costly) provider for every message, so this
  // follows the exact same override pattern as MANDO_RATE_LIMIT_IMAGES_MAX
  // above rather than introducing a new shape.
  MANDO_RATE_LIMIT_CHAT_MAX: z.coerce.number().int().positive().optional(),
  // How often index.ts re-runs retention.ts's runRetention() sweep after its
  // initial startup pass. Defaults to hourly (retention.ts) when unset --
  // this only lets an operator override the cadence, same pattern as the
  // rate-limit maxes above.
  MANDO_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  // Enables the images/provider feature (crypto/secretbox.ts): a per-user
  // provider API key is encrypted at rest with this AES-256-GCM key. Left
  // unset, isEncryptionConfigured() reports false and every provider/images
  // route hard-disables (503) rather than ever writing a plaintext key --
  // there is no "encryption optional" mode for that data. Accepts hex
  // (`openssl rand -hex 32`, 64 hex chars) or base64, decoded below and
  // hard-checked to be exactly 32 bytes -- a wrong-length key would either
  // silently truncate/pad (weakening it) or throw deep inside node:crypto
  // at first use instead of at startup where an operator will actually see it.
  MANDO_ENCRYPTION_KEY: z.string().min(1).optional(),
  // Where generated/edited image bytes live on disk (images/storage.ts) --
  // moved off Postgres bytea (v1.4) because per-user galleries grow
  // unbounded and bytea rows bloat the DB/backups for data that's cheap to
  // regenerate. Defaults to a repo-local dev directory; deploy/docker-
  // compose.yml and deploy/k8s override this to a mounted volume
  // (/data/images) so the directory survives container restarts/rescheduling.
  MANDO_IMAGE_DIR: z.string().min(1).default(".mando-images"),
  // Dual retention enforced by retention.ts's scheduled sweep (images/repo.ts's
  // retainImages): delete anything older than this many days, AND separately
  // cap each user at MANDO_IMAGE_MAX_PER_USER (oldest deleted first) --
  // either condition alone triggers deletion for a given row.
  MANDO_IMAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  MANDO_IMAGE_MAX_PER_USER: z.coerce.number().int().positive().default(100),
});

// Exactly 64 lowercase/uppercase hex characters decodes to 32 bytes -- that
// exact shape is treated as hex; anything else (notably base64's 44-char,
// `+/=`-containing form for a 32-byte key) is decoded as base64. A base64
// string composed entirely of hex-looking characters would be misread as
// hex here, but it would then fail the 32-byte length check below and hard
// fail startup rather than silently accepting a wrong key -- so the
// ambiguity is safe, not just unlikely.
function decodeEncryptionKey(raw: string): Buffer {
  const isHex = raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw);
  const decoded = isHex ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error(
      `MANDO_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${decoded.length}); generate one with \`openssl rand -hex 32\``,
    );
  }
  return decoded;
}

export type Config = {
  port: number;
  databaseUrl: string;
  cookieSecret: string;
  publicUrl: string;
  adminEmail?: string;
  adminPassword?: string;
  rateLimitLoginMax?: number;
  rateLimitPairingMax?: number;
  rateLimitWsAgentMax?: number;
  rateLimitImagesMax?: number;
  rateLimitChatMax?: number;
  retentionIntervalMs?: number;
  encryptionKey?: Buffer;
  imageDir: string;
  imageRetentionDays: number;
  imageMaxPerUser: number;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const p = Schema.parse(env);
  return {
    port: p.PORT,
    databaseUrl: p.DATABASE_URL,
    cookieSecret: p.COOKIE_SECRET,
    publicUrl: p.PUBLIC_URL,
    adminEmail: p.MANDO_ADMIN_EMAIL,
    adminPassword: p.MANDO_ADMIN_PASSWORD,
    rateLimitLoginMax: p.MANDO_RATE_LIMIT_LOGIN_MAX,
    rateLimitPairingMax: p.MANDO_RATE_LIMIT_PAIRING_MAX,
    rateLimitWsAgentMax: p.MANDO_RATE_LIMIT_WS_AGENT_MAX,
    rateLimitImagesMax: p.MANDO_RATE_LIMIT_IMAGES_MAX,
    rateLimitChatMax: p.MANDO_RATE_LIMIT_CHAT_MAX,
    retentionIntervalMs: p.MANDO_RETENTION_INTERVAL_MS,
    encryptionKey: p.MANDO_ENCRYPTION_KEY ? decodeEncryptionKey(p.MANDO_ENCRYPTION_KEY) : undefined,
    imageDir: p.MANDO_IMAGE_DIR,
    imageRetentionDays: p.MANDO_IMAGE_RETENTION_DAYS,
    imageMaxPerUser: p.MANDO_IMAGE_MAX_PER_USER,
  };
}

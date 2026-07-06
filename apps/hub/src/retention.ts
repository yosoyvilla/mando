import type postgres from "postgres";
import { sweepPendingTokens } from "./pairing/service";
import { retainImages } from "./images/repo";

type Sql = ReturnType<typeof postgres>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_RETENTION_WINDOW_MS = THIRTY_DAYS_MS;

// Mirror config.ts's MANDO_IMAGE_RETENTION_DAYS/MANDO_IMAGE_MAX_PER_USER
// defaults, used only if a caller passes imageDir without also passing
// these two (index.ts always passes all three together from Config, so
// this only matters for callers/tests that construct RetentionOptions by
// hand).
const DEFAULT_IMAGE_RETENTION_DAYS = 7;
const DEFAULT_IMAGE_MAX_PER_USER = 100;

export type RetentionOptions = {
  // How long a revoked machine_tokens row is kept before it's purged.
  // Recently-revoked tokens stay around for audit/investigation purposes;
  // this is purely a data-minimization purge of the row itself, not the
  // separate audit_log trail (see audit.ts), which is unaffected.
  tokenRetentionWindowMs?: number;
  // Images sweep (images/repo.ts's retainImages): unlinks files + deletes
  // rows older than imageRetentionDays, or beyond imageMaxPerUser per
  // user. Left undefined, the images sweep is skipped entirely -- callers
  // that don't care about images (most existing tests, and any caller
  // that hasn't wired up MANDO_IMAGE_DIR) get the exact same behavior as
  // before this option existed.
  imageDir?: string;
  imageRetentionDays?: number;
  imageMaxPerUser?: number;
};

export type RetentionSummary = {
  sessionsDeleted: number;
  pairingsDeleted: number;
  tokensDeleted: number;
  imagesDeleted: number;
};

// Single-pass cleanup of everything that's only ever checked-and-ignored
// at read time today (expired sessions in auth/session.ts's readSession,
// expired/consumed pairing_requests in pairing/service.ts's
// findPairingRequestByCode-based checks) plus revoked machine_tokens past
// their retention window and pairing/service.ts's in-memory pendingTokens
// handoff map. Intended to be idempotent and safe to run concurrently with
// normal traffic -- every delete is a plain bounded WHERE, no locking
// beyond what Postgres does for the statement itself.
export async function runRetention(sql: Sql, opts?: RetentionOptions): Promise<RetentionSummary> {
  const tokenRetentionWindowMs = opts?.tokenRetentionWindowMs ?? DEFAULT_TOKEN_RETENTION_WINDOW_MS;
  const tokenCutoff = new Date(Date.now() - tokenRetentionWindowMs);

  const deletedSessions = await sql`
    delete from user_sessions where expires_at < now() returning id
  `;

  // Consumed pairing_requests are done regardless of expiry (the code has
  // already been used); expired-but-never-consumed ones are just dead
  // weight. Either way, once the row is gone the plaintext handoff in
  // pairing/service.ts's pendingTokens map (if any) for that code is
  // unreachable through the normal poll path -- sweepPendingTokens drops
  // it explicitly rather than letting it leak for the process lifetime.
  const deletedPairings = await sql`
    delete from pairing_requests
    where expires_at < now() or consumed_at is not null
    returning code
  `;
  sweepPendingTokens(deletedPairings.map((row) => row.code as string));

  const deletedTokens = await sql`
    delete from machine_tokens
    where revoked_at is not null and revoked_at < ${tokenCutoff}
    returning id
  `;

  // Images sweep is opt-in via imageDir (see RetentionOptions' doc
  // comment) -- skipped, not defaulted to a directory, when unset.
  const imagesDeleted = opts?.imageDir
    ? (
        await retainImages(sql, opts.imageDir, {
          retentionDays: opts.imageRetentionDays ?? DEFAULT_IMAGE_RETENTION_DAYS,
          maxPerUser: opts.imageMaxPerUser ?? DEFAULT_IMAGE_MAX_PER_USER,
        })
      ).deleted
    : 0;

  const summary: RetentionSummary = {
    sessionsDeleted: deletedSessions.length,
    pairingsDeleted: deletedPairings.length,
    tokensDeleted: deletedTokens.length,
    imagesDeleted,
  };

  // No PII here -- just counts.
  console.log(
    `retention: sessions=${summary.sessionsDeleted} pairings=${summary.pairingsDeleted} tokens=${summary.tokensDeleted} images=${summary.imagesDeleted}`,
  );

  return summary;
}

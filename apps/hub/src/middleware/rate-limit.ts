import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

export type RateLimitConfig = {
  // Fixed-window size. A client gets `max` requests per window, then every
  // further request in that window is rejected until the window rolls over.
  windowMs: number;
  max: number;
};

// M3 fix: unauthenticated endpoints (login, pairing) had no rate limiting,
// so a single client could drive unlimited argon2id verifies (CPU
// exhaustion) or unlimited pairing_requests inserts (DB flood). These
// defaults are deliberately generous for legitimate use and tight enough to
// blunt a single-IP flood; buildApp (src/app.ts) lets callers override them
// per route, which tests use to exercise the 429 path without waiting out a
// real 60s window.
export const DEFAULT_RATE_LIMITS = {
  login: { windowMs: 60_000, max: 10 },
  pairingRequest: { windowMs: 60_000, max: 30 },
  pairingStatus: { windowMs: 60_000, max: 30 },
  wsAgent: { windowMs: 60_000, max: 30 },
} as const satisfies Record<string, RateLimitConfig>;

type Bucket = {
  count: number;
  resetAt: number;
};

// Best-effort client identity for rate limiting. `x-forwarded-for` is
// checked first and, per convention, is only trustworthy when the hub sits
// behind a proxy/load balancer that sets it itself and strips/overwrites
// any client-supplied value -- deploying without such a trusted proxy in
// front lets a client forge this header and evade per-IP limiting
// entirely. getConnInfo (hono/bun) is the fallback for direct connections;
// it throws when the request wasn't dispatched through a real Bun server
// (e.g. Hono's `app.request()` test helper used by unit tests without a
// running Bun.serve), so unit tests instead simulate distinct clients via
// the X-Forwarded-For header and everything else collapses into a single
// "unknown" bucket -- an acceptable loss of precision for a best-effort,
// single-replica limiter.
function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // No real Bun server behind this request (e.g. app.request() in tests).
  }
  return "unknown";
}

// In-memory per-IP fixed-window limiter. Single-process design: the bucket
// map lives in this process's memory, so it only works correctly for a
// single hub replica -- running multiple replicas behind a load balancer
// would need a shared store (Redis, etc.) for the limit to hold across all
// of them. Fine for this hub's documented single-instance deployment model
// (see pairing/service.ts's pendingTokens for the same tradeoff elsewhere).
export function createRateLimiter(config: RateLimitConfig): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  // Sweep expired buckets at most once per window rather than on every
  // request, so the map never grows unbounded across many distinct
  // clients/IPs (data minimization) without paying sweep cost per-request.
  // Expired buckets not yet swept still self-correct via the resetAt check
  // below, so this is a memory bound, not a correctness dependency.
  const sweepIntervalMs = Math.max(config.windowMs, 60_000);
  let lastSweepAt = Date.now();

  function sweep(now: number): void {
    if (now - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return async (c, next) => {
    const now = Date.now();
    sweep(now);

    const key = clientIp(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;
    if (bucket.count > config.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: "too many requests" }, 429);
    }

    await next();
  };
}

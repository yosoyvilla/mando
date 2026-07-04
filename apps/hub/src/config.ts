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
});

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
  };
}

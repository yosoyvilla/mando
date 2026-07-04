import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import type postgres from "postgres";
import { createUser, findUserByEmail, findUserById } from "./repo";
import { verifySecret, DUMMY_HASH } from "../auth/password";
import { createSession, destroySession } from "../auth/session";
import { requireUser, requireAdmin, type AuthVariables } from "../auth/middleware";

type Sql = ReturnType<typeof postgres>;

const SESSION_COOKIE = "mando_sess";
const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const bootstrapSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

const inviteSchema = z.object({
  email: z.email(),
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function randomTempPassword(): string {
  // 32 hex chars of crypto-random material -- plenty of entropy for a
  // one-time temp password the invitee is expected to change on first use.
  return crypto.randomUUID().replaceAll("-", "");
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 = unique_violation -- same detection the
  // `postgres` client surfaces on `.code` used in pairing/service.ts.
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: THIRTY_DAYS_SECONDS,
  });
}

export function userRoutes(sql: Sql): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/api/v1/auth/login", async (c) => {
    const parsed = loginSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const { email, password } = parsed.data;

    const user = await findUserByEmail(sql, email);
    // Always run a full argon2 verify, even when the user doesn't exist,
    // so the response time doesn't leak whether the email was
    // registered. Falling back to "" here would let argon2 short-circuit
    // on a malformed hash and return much faster than a real verify --
    // DUMMY_HASH is a real argon2id hash so the verify does equivalent
    // work either way. Return the same generic message either way too.
    const hash = user?.password_hash ?? DUMMY_HASH;
    const ok = await verifySecret(password, hash);
    if (!user || !ok) return c.json({ error: "invalid credentials" }, 401);

    const sessionId = await createSession(sql, user.id);
    setSessionCookie(c, sessionId);
    return c.json({ user: { id: user.id, email: user.email } }, 200);
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) await destroySession(sql, sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true }, 200);
  });

  app.get("/api/v1/me", requireUser(sql), async (c) => {
    const user = await findUserById(sql, c.get("userId"));
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ id: user.id, email: user.email }, 200);
  });

  app.post("/api/v1/auth/bootstrap", async (c) => {
    const parsed = bootstrapSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const [{ count }] = await sql`select count(*)::int as count from users`;
    if (count > 0) return c.json({ error: "already initialized" }, 409);

    const { email, password } = parsed.data;
    // The first (and, by the count check above, only) user created this
    // way is the bootstrap admin -- give it is_admin so it can actually use
    // the admin-gated /api/v1/auth/invite below.
    const user = await createUser(sql, email, password, { isAdmin: true });
    return c.json({ user: { id: user.id, email: user.email } }, 201);
  });

  // requireAdmin (after requireUser) closes M4: previously *any*
  // authenticated user could invite -- i.e. create accounts and see the
  // invitee's tempPassword -- with no role check at all.
  app.post("/api/v1/auth/invite", requireUser(sql), requireAdmin(sql), async (c) => {
    const parsed = inviteSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const tempPassword = randomTempPassword();
    try {
      const user = await createUser(sql, parsed.data.email, tempPassword);
      return c.json({ user: { id: user.id, email: user.email }, tempPassword }, 201);
    } catch (err) {
      // Inviting an email that already exists hits users.email's unique
      // constraint. Left uncaught, that surfaced as an unhandled 500 for a
      // duplicate while a fresh email returned 201 -- a reliable oracle any
      // logged-in user could use to test "is this email registered?". A
      // generic 409 with no email-specific wording removes the signal.
      if (isUniqueViolation(err)) return c.json({ error: "could not create user" }, 409);
      throw err;
    }
  });

  return app;
}

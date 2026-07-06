import { Hono, type Context } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import type postgres from "postgres";
import { countUsersAndAdmins, createUser, deleteUser, findUserByEmail, findUserById, listUsers } from "./repo";
import { verifySecret, DUMMY_HASH } from "../auth/password";
import { createSession, destroySession, readSession } from "../auth/session";
import { requireUser, requireAdmin, type AuthVariables } from "../auth/middleware";
import { listMachines } from "../machines/repo";
import type { Registry } from "../tunnel/registry";
import { logAudit } from "../audit";
import { clientIp } from "../middleware/rate-limit";

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

// Closes any live tunnel for each of the given user's machines and drops
// them from the registry -- remove-then-close, matching
// machines/routes.ts's revoke handler, so a concurrent request can't
// observe a not-yet-removed conn during the async socket teardown that the
// WS handler's own onClose would otherwise do. Must run before the user
// row is deleted: listMachines needs the machines rows, which the
// subsequent cascade delete removes.
async function closeUserTunnels(sql: Sql, registry: Registry, userId: string): Promise<void> {
  const machines = await listMachines(sql, userId);
  for (const machine of machines) {
    const conn = registry.get(machine.id);
    if (!conn) continue;
    registry.remove(machine.id);
    conn.close();
  }
}

export function userRoutes(sql: Sql, registry: Registry): Hono<{ Variables: AuthVariables }> {
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
    if (!user || !ok) {
      // No target/email here -- logging the attempted email would let the
      // audit trail itself become a PII/enumeration surface. Just the
      // event type and IP.
      await logAudit(sql, { eventType: "login_failure", ip: clientIp(c) });
      return c.json({ error: "invalid credentials" }, 401);
    }

    const sessionId = await createSession(sql, user.id);
    setSessionCookie(c, sessionId);
    await logAudit(sql, { eventType: "login_success", actorUserId: user.id, ip: clientIp(c) });
    return c.json({ user: { id: user.id, email: user.email, isAdmin: user.is_admin } }, 200);
  });

  app.post("/api/v1/auth/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE);
    if (sessionId) {
      const session = await readSession(sql, sessionId);
      await destroySession(sql, sessionId);
      if (session) await logAudit(sql, { eventType: "logout", actorUserId: session.userId, ip: clientIp(c) });
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true }, 200);
  });

  // Right to erasure (GDPR Art.17 / CCPA deletion): the caller erases
  // their own account. Order matters: tunnels must close on live machines
  // (which still exist) before deleteUser's cascade removes them, and the
  // audit write must happen *before* deleteUser, not after -- audit_log's
  // actor_user_id has a real FK to users(id) (ON DELETE SET NULL only
  // governs what happens to an *existing* row when its referenced user is
  // later deleted; it does not let a fresh insert reference a user id that
  // is already gone). Logging first, while the row still exists, is what
  // lets that same row's actor later go to null on deletion instead of the
  // insert itself failing the FK check.
  app.delete("/api/v1/me", requireUser(sql), async (c) => {
    const userId = c.get("userId");
    const me = await findUserById(sql, userId);
    if (me?.is_admin) {
      const { total, admins } = await countUsersAndAdmins(sql);
      // Blocking here prevents an unrecoverable state: if the last admin
      // self-erased while other users remained, bootstrap stays 409 forever
      // (it refuses once any user exists) and no one could regain admin. A
      // solo admin who is the only user is still free to erase (total <= 1),
      // since that empties the table and reopens bootstrap.
      if (admins <= 1 && total > 1) {
        return c.json({ error: "cannot delete the last admin while other users exist" }, 400);
      }
    }
    await closeUserTunnels(sql, registry, userId);
    await logAudit(sql, { eventType: "user_deleted_self", actorUserId: userId, ip: clientIp(c) });
    await deleteUser(sql, userId);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true }, 200);
  });

  // Admin erasure of another user by id. requireAdmin gates this the same
  // way it gates invite below. 404s (rather than a generic error) when
  // deleteUser finds no matching row -- covers both "never existed" and
  // "already deleted" with the same response, avoiding a distinct signal
  // for either.
  app.delete("/api/v1/users/:id", requireUser(sql), requireAdmin(sql), async (c) => {
    const targetId = c.req.param("id");
    if (targetId === c.get("userId")) {
      return c.json({ error: "cannot delete your own admin account here" }, 400);
    }
    await closeUserTunnels(sql, registry, targetId);
    const deleted = await deleteUser(sql, targetId);
    if (!deleted) return c.json({ error: "not found" }, 404);

    await logAudit(sql, {
      eventType: "user_deleted_by_admin",
      actorUserId: c.get("userId"),
      target: targetId,
      ip: clientIp(c),
    });
    return c.json({ ok: true }, 200);
  });

  app.get("/api/v1/me", requireUser(sql), async (c) => {
    const user = await findUserById(sql, c.get("userId"));
    if (!user) return c.json({ error: "unauthorized" }, 401);
    return c.json({ id: user.id, email: user.email, isAdmin: user.is_admin }, 200);
  });

  app.get("/api/v1/users", requireUser(sql), requireAdmin(sql), async (c) => {
    const users = await listUsers(sql);
    return c.json(
      {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          isAdmin: u.is_admin,
          createdAt: u.created_at,
        })),
      },
      200,
    );
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
    await logAudit(sql, { eventType: "bootstrap_admin", actorUserId: user.id, ip: clientIp(c) });
    return c.json({ user: { id: user.id, email: user.email, isAdmin: user.is_admin } }, 201);
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
      await logAudit(sql, {
        eventType: "invite",
        actorUserId: c.get("userId"),
        target: user.id,
        ip: clientIp(c),
      });
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

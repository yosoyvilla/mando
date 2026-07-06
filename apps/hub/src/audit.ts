import { Hono } from "hono";
import type postgres from "postgres";
import { requireUser, requireAdmin, type AuthVariables } from "./auth/middleware";

type Sql = ReturnType<typeof postgres>;
// audit writes/reads only ever need the shared tagged-template query
// surface, so callers that already hold a transaction handle (e.g. a
// route that also touched the DB inside sql.begin(...)) can pass that
// through too -- see machines/repo.ts's Executor alias for the same idea.
type Executor = postgres.ISql;

export type AuditEventType =
  | "login_success"
  | "login_failure"
  | "logout"
  | "invite"
  | "bootstrap_admin"
  | "pairing_approved"
  | "machine_revoked"
  | "user_deleted_self"
  | "user_deleted_by_admin"
  | "password_changed"
  | "user_role_changed";

export type AuditEventInput = {
  eventType: AuditEventType;
  // Always a users.id, never an email -- audit_log must never carry PII
  // that identifies a person by anything other than an opaque id (see
  // migrations/003_audit_log.sql: actor_user_id is ON DELETE SET NULL so
  // erasing a user doesn't erase the events they caused).
  actorUserId?: string | null;
  // A free-form reference to whatever the event acted on (e.g. a machine
  // id or a deleted user's id) -- never an email or secret.
  target?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
};

// Best-effort, append-only audit write. Deliberately never throws: an
// audit-log outage (e.g. a bad connection, a locked table) must not turn
// into a 500 for the login/invite/revoke/deletion request that triggered
// it. Failures are still surfaced via console.error so they don't vanish
// silently -- same "log, don't throw" shape as requireMachineOwnership's
// DB-error handling in auth/middleware.ts.
export async function logAudit(sql: Executor, input: AuditEventInput): Promise<void> {
  try {
    await sql`
      insert into audit_log (event_type, actor_user_id, target, ip, metadata)
      values (
        ${input.eventType},
        ${input.actorUserId ?? null},
        ${input.target ?? null},
        ${input.ip ?? null},
        ${input.metadata ? JSON.stringify(input.metadata) : null}
      )
    `;
  } catch (err) {
    console.error("logAudit: failed to write audit event", input.eventType, err);
  }
}

export type AuditLogRow = {
  id: string;
  created_at: Date | string;
  event_type: string;
  actor_user_id: string | null;
  target: string | null;
  ip: string | null;
  metadata: unknown;
};

const MAX_AUDIT_LIMIT = 200;
const DEFAULT_AUDIT_LIMIT = 50;

export async function listAuditLog(sql: Sql, limit = DEFAULT_AUDIT_LIMIT): Promise<AuditLogRow[]> {
  const capped = Math.min(Math.max(1, limit), MAX_AUDIT_LIMIT);
  const rows = await sql`
    select id, created_at, event_type, actor_user_id, target, ip, metadata
    from audit_log
    order by created_at desc
    limit ${capped}
  `;
  return rows as unknown as AuditLogRow[];
}

// Admin-only: the audit trail can reveal who did what (ids, ips), so it
// stays behind the same requireUser + requireAdmin gate as invite.
export function auditRoutes(sql: Sql): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/v1/audit", requireUser(sql), requireAdmin(sql), async (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit ? Number(rawLimit) : DEFAULT_AUDIT_LIMIT;
    const events = await listAuditLog(sql, Number.isFinite(limit) ? limit : DEFAULT_AUDIT_LIMIT);
    return c.json({ events }, 200);
  });

  return app;
}

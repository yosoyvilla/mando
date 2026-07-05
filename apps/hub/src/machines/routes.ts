import { Hono } from "hono";
import type postgres from "postgres";
import { requireUser, requireMachineOwnership, type AuthVariables, type Machine } from "../auth/middleware";
import { listMachines, revokeMachine } from "./repo";
import type { Registry } from "../tunnel/registry";
import { logAudit } from "../audit";
import { clientIp } from "../middleware/rate-limit";

type Sql = ReturnType<typeof postgres>;

function serializeMachine(machine: Machine, online: boolean) {
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    lastSeenAt: machine.last_seen_at,
    revokedAt: machine.revoked_at,
    createdAt: machine.created_at,
    connectDirectory: machine.connect_directory ?? null,
    online,
  };
}

export function machineRoutes(sql: Sql, registry: Registry): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get("/api/v1/machines", requireUser(sql), async (c) => {
    const machines = await listMachines(sql, c.get("userId"));
    return c.json(
      { machines: machines.map((m) => serializeMachine(m, registry.get(m.id) !== null)) },
      200,
    );
  });

  app.get("/api/v1/machines/:id", requireUser(sql), requireMachineOwnership(sql), async (c) => {
    const machine = c.get("machine");
    return c.json({ machine: serializeMachine(machine, registry.get(machine.id) !== null) }, 200);
  });

  app.post("/api/v1/machines/:id/revoke", requireUser(sql), requireMachineOwnership(sql), async (c) => {
    const machine = c.get("machine");
    await revokeMachine(sql, machine.id);

    // Drop any live tunnel immediately -- a revoked machine must not be
    // able to keep using an already-established connection. Remove from
    // the registry before closing so a concurrent request can't observe
    // a not-yet-removed conn during the (async, event-driven) socket
    // teardown that the WS handler's own onClose would otherwise do.
    const conn = registry.get(machine.id);
    if (conn) {
      registry.remove(machine.id);
      conn.close();
    }

    await logAudit(sql, {
      eventType: "machine_revoked",
      actorUserId: c.get("userId"),
      target: machine.id,
      ip: clientIp(c),
    });

    return c.json({ ok: true }, 200);
  });

  return app;
}

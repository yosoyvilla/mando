import { Hono, type Context } from "hono";
import { z } from "zod";
import type postgres from "postgres";
import { approvePairing, createPairingRequest, pollPairing, PairingError, type PairingErrorReason } from "./service";
import { requireUser, type AuthVariables } from "../auth/middleware";
import { logAudit } from "../audit";
import { clientIp } from "../middleware/rate-limit";

type Sql = ReturnType<typeof postgres>;

const requestSchema = z.object({
  machineName: z.string().min(1),
  platform: z.string().min(1).optional(),
});

const approveSchema = z.object({
  code: z.string().min(1),
});

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function statusForPairingError(reason: PairingErrorReason): 404 | 409 | 410 {
  switch (reason) {
    case "not_found":
      return 404;
    case "already_consumed":
      return 409;
    case "expired":
      return 410;
  }
}

export function pairingRoutes(sql: Sql): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // No auth: the agent calls this before it has any credentials at all.
  app.post("/api/v1/pairing/request", async (c) => {
    const parsed = requestSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const { code, expiresAt } = await createPairingRequest(sql, parsed.data);
    return c.json({ code, expiresAt }, 201);
  });

  // No auth: the agent polls this with only the pairing code, before it
  // has a session or a machine token.
  app.get("/api/v1/pairing/status", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.json({ error: "invalid request" }, 400);

    try {
      const result = await pollPairing(sql, code);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof PairingError) return c.json({ error: err.reason }, statusForPairingError(err.reason));
      throw err;
    }
  });

  app.post("/api/v1/pairing/approve", requireUser(sql), async (c) => {
    const parsed = approveSchema.safeParse(await parseJsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    try {
      // Deliberately do not return `token` here -- it is only ever handed
      // to the agent via GET /pairing/status, never to the approving
      // browser session.
      const { machineId } = await approvePairing(sql, c.get("userId"), parsed.data.code);
      await logAudit(sql, {
        eventType: "pairing_approved",
        actorUserId: c.get("userId"),
        target: machineId,
        ip: clientIp(c),
      });
      return c.json({ machineId }, 200);
    } catch (err) {
      if (err instanceof PairingError) return c.json({ error: err.reason }, statusForPairingError(err.reason));
      throw err;
    }
  });

  return app;
}

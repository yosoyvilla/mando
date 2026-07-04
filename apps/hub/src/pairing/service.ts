import type postgres from "postgres";
import { hashSecret } from "../auth/password";
import { createMachine, insertMachineToken } from "../machines/repo";
import { consumePairingRequest, findPairingRequestByCode, insertPairingRequest } from "./repo";

type Sql = ReturnType<typeof postgres>;

// Alphabet excludes visually ambiguous characters (0/O, 1/I/L) so a code
// read aloud or typed by hand doesn't hit a transcription error.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const TEN_MINUTES_MS = 10 * 60 * 1000;
const MAX_CODE_COLLISION_RETRIES = 5;

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 = unique_violation. The `postgres` client
  // surfaces it as `.code` on the thrown error.
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export type PairingErrorReason = "not_found" | "expired" | "already_consumed";

export class PairingError extends Error {
  readonly reason: PairingErrorReason;

  constructor(reason: PairingErrorReason) {
    super(`pairing request ${reason}`);
    this.name = "PairingError";
    this.reason = reason;
  }
}

// Approved tokens are held here just long enough for the agent's next poll
// to collect them once. machine_tokens only ever stores the argon2 hash
// (see machines/repo.ts findMachineByToken), so once approvePairing
// returns, the plaintext token exists nowhere durable -- this map is the
// only place it survives between "approve" (browser) and "poll" (agent).
// That's a deliberate tradeoff: it only works within a single running hub
// process and within the 10-minute pairing window, which matches this
// hub's single-instance, self-hosted deployment model. A hub restart
// between approve and poll loses the handoff and the user re-pairs.
const pendingTokens = new Map<string, string>();

export async function createPairingRequest(
  sql: Sql,
  input: { machineName: string; platform?: string | null },
): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + TEN_MINUTES_MS);

  for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRIES; attempt++) {
    const code = generateCode();
    try {
      await insertPairingRequest(sql, {
        code,
        machineName: input.machineName,
        platform: input.platform ?? null,
        expiresAt,
      });
      return { code, expiresAt };
    } catch (err) {
      // 31^8 (~8.5e11) possible codes -- a collision is only plausible as
      // a freak coincidence, never as a systemic issue. Retry rather than
      // fail the request outright.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("failed to allocate a unique pairing code");
}

export async function approvePairing(
  sql: Sql,
  userId: string,
  code: string,
): Promise<{ machineId: string; token: string }> {
  const request = await findPairingRequestByCode(sql, code);
  if (!request) throw new PairingError("not_found");
  if (request.consumed_at) throw new PairingError("already_consumed");
  if (new Date(request.expires_at).getTime() <= Date.now()) throw new PairingError("expired");

  const token = generateToken();
  const tokenHash = await hashSecret(token);

  // Mint the machine + token and consume the code atomically. The
  // `consumed_at is null` guard on the update means only one concurrent
  // approve can win the race for a given code; if this one loses, the
  // transaction rolls back so no orphan machine/token survives.
  const machineId = await sql.begin(async (tx) => {
    const machine = await createMachine(tx, {
      userId,
      name: request.machine_name,
      platform: request.platform,
    });
    await insertMachineToken(tx, { machineId: machine.id, tokenHash });

    const consumed = await consumePairingRequest(tx, code, userId, machine.id);
    if (!consumed) throw new PairingError("already_consumed");

    return machine.id;
  });

  pendingTokens.set(code, token);
  return { machineId, token };
}

export async function pollPairing(
  sql: Sql,
  code: string,
): Promise<{ status: "pending" | "approved"; token?: string }> {
  const request = await findPairingRequestByCode(sql, code);
  if (!request) throw new PairingError("not_found");

  if (request.consumed_at) {
    const token = pendingTokens.get(code);
    // Hand the token off exactly once -- clear it so a later poll (e.g.
    // the agent retrying after a dropped response) can't replay it.
    pendingTokens.delete(code);
    return token ? { status: "approved", token } : { status: "approved" };
  }

  if (new Date(request.expires_at).getTime() <= Date.now()) throw new PairingError("expired");

  return { status: "pending" };
}

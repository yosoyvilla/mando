export function hashSecret(s: string): Promise<string> {
  return Bun.password.hash(s, { algorithm: "argon2id" });
}

export function verifySecret(s: string, hash: string): Promise<boolean> {
  return Bun.password.verify(s, hash);
}

// A precomputed, valid argon2id hash with no corresponding real account.
// Login uses this in place of a missing user's password_hash so the
// verify call always does full argon2 work -- an empty/malformed hash
// short-circuits quickly and creates a timing oracle that lets an
// attacker distinguish "unknown email" from "wrong password" by
// response time alone, even when the HTTP status/body are identical.
export const DUMMY_HASH = await Bun.password.hash("mando-dummy-password", {
  algorithm: "argon2id",
});

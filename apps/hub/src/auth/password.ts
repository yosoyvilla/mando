// Explicit OWASP-baseline argon2id params (memoryCost in KiB, timeCost in
// iterations) instead of relying on Bun.password's built-in defaults --
// those defaults are Bun's to change across versions without notice, which
// would silently move every password/token hash's cost (and thus its
// brute-force resistance) up or down on a routine `bun upgrade`. Pinning
// them here means a cost change is a deliberate, reviewed edit to this
// file. 19456 KiB (19 MiB) / timeCost 2 matches OWASP's current argon2id
// baseline recommendation for a single-threaded server-side verify.
const ARGON2ID_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 19_456,
  timeCost: 2,
} as const;

export function hashSecret(s: string): Promise<string> {
  return Bun.password.hash(s, ARGON2ID_PARAMS);
}

// argon2's encoded hash string embeds the params it was created with
// (algorithm, memoryCost, timeCost, salt), so verify() reads them back out
// of `hash` itself rather than from ARGON2ID_PARAMS -- a hash made under a
// previous params value (or Bun's old built-in default) keeps verifying
// correctly even after ARGON2ID_PARAMS changes.
export function verifySecret(s: string, hash: string): Promise<boolean> {
  return Bun.password.verify(s, hash);
}

// A precomputed, valid argon2id hash with no corresponding real account.
// Login uses this in place of a missing user's password_hash so the
// verify call always does full argon2 work -- an empty/malformed hash
// short-circuits quickly and creates a timing oracle that lets an
// attacker distinguish "unknown email" from "wrong password" by
// response time alone, even when the HTTP status/body are identical.
export const DUMMY_HASH = await Bun.password.hash("mando-dummy-password", ARGON2ID_PARAMS);

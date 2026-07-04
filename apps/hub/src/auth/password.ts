export function hashSecret(s: string): Promise<string> {
  return Bun.password.hash(s, { algorithm: "argon2id" });
}

export function verifySecret(s: string, hash: string): Promise<boolean> {
  return Bun.password.verify(s, hash);
}

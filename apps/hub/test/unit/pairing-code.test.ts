import { test, expect } from "bun:test";
import { generateCode } from "../../src/pairing/service";

const AMBIGUOUS_CHARS = ["0", "O", "1", "I", "L"];

test("generateCode returns an XXXX-XXXX shaped code", () => {
  const code = generateCode();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
});

test("generateCode excludes ambiguous characters (0, O, 1, I, L)", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    for (const ambiguous of AMBIGUOUS_CHARS) {
      expect(code).not.toContain(ambiguous);
    }
  }
});

test("generateCode produces varied codes across calls", () => {
  const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
  expect(codes.size).toBeGreaterThan(1);
});

// Rejection sampling (replacing `byte % 31`) should make every alphabet
// character equally likely. `byte % 31` would have skewed the first
// 256 % 31 == 8 characters (2,3,4,5,6,7,8,9) to appear ~9/8 as often as the
// rest -- over a large enough sample that shows up as a clear frequency
// gap; a wide tolerance keeps this from flaking on ordinary sampling noise
// while still catching that systematic bias.
test("generateCode's character distribution shows no modulo bias", () => {
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const counts = new Map<string, number>();
  for (const ch of ALPHABET) counts.set(ch, 0);

  const samples = 20_000;
  for (let i = 0; i < samples; i++) {
    for (const ch of generateCode().replace("-", "")) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }

  const totalChars = samples * 8;
  const expected = totalChars / ALPHABET.length;
  for (const [, count] of counts) {
    // +/-25% of the expected uniform count -- generous enough to absorb
    // random sampling noise but far tighter than the ~12.5% skew a modulo
    // bias would produce on the affected characters.
    expect(count).toBeGreaterThan(expected * 0.75);
    expect(count).toBeLessThan(expected * 1.25);
  }
});

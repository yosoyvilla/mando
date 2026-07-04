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

import { describe, it, expect } from "bun:test";
import { nextDelay } from "../../src/reconnect";

describe("nextDelay", () => {
  it("returns 1000ms when attempt=0 and rand=0", () => {
    expect(nextDelay(0, () => 0)).toBe(1000);
  });

  it("returns 60000ms (capped) when attempt=10 and rand=1", () => {
    expect(nextDelay(10, () => 1)).toBe(60000);
  });

  it("has monotonically increasing ceiling before cap", () => {
    const rand = () => 1; // Always get the ceiling
    expect(nextDelay(0, rand)).toBeLessThanOrEqual(nextDelay(1, rand));
    expect(nextDelay(1, rand)).toBeLessThanOrEqual(nextDelay(2, rand));
    expect(nextDelay(2, rand)).toBeLessThanOrEqual(nextDelay(3, rand));
    expect(nextDelay(3, rand)).toBeLessThanOrEqual(nextDelay(4, rand));
    expect(nextDelay(4, rand)).toBeLessThanOrEqual(nextDelay(5, rand));
    expect(nextDelay(5, rand)).toBeLessThanOrEqual(nextDelay(6, rand));
  });

  it("defaults to Math.random when rand param is not provided", () => {
    const delay = nextDelay(1);
    expect(typeof delay).toBe("number");
    expect(delay).toBeGreaterThanOrEqual(1000); // base
    expect(delay).toBeLessThanOrEqual(4000); // base * 2^1 at attempt 1
  });

  it("applies full jitter correctly across attempts", () => {
    // At attempt 0: ceiling = 1000, so delay should be 1000 + rand() * 0 = 1000
    expect(nextDelay(0, () => 0)).toBe(1000);
    expect(nextDelay(0, () => 1)).toBe(1000);
    expect(nextDelay(0, () => 0.5)).toBe(1000);

    // At attempt 1: ceiling = 2000, so delay should be 1000 + rand() * 1000
    expect(nextDelay(1, () => 0)).toBe(1000);
    expect(nextDelay(1, () => 1)).toBe(2000);
    expect(nextDelay(1, () => 0.5)).toBe(1500);

    // At attempt 2: ceiling = 4000, so delay should be 1000 + rand() * 3000
    expect(nextDelay(2, () => 0)).toBe(1000);
    expect(nextDelay(2, () => 1)).toBe(4000);
    expect(nextDelay(2, () => 0.5)).toBe(2500);
  });
});

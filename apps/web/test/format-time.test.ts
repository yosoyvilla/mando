import { describe, it, expect } from "bun:test";
import { formatRelativeTime, formatAbsoluteTime } from "../src/lib/format-time";

describe("formatRelativeTime", () => {
  const now = new Date("2026-07-04T15:00:00.000Z");

  it("returns 'just now' for timestamps under a minute old", () => {
    expect(formatRelativeTime("2026-07-04T14:59:30.000Z", now)).toBe(
      "just now",
    );
  });

  it("humanizes minutes", () => {
    expect(formatRelativeTime("2026-07-04T14:55:00.000Z", now)).toBe(
      "5 minutes ago",
    );
  });

  it("uses singular units", () => {
    expect(formatRelativeTime("2026-07-04T14:00:00.000Z", now)).toBe(
      "1 hour ago",
    );
  });

  it("humanizes hours", () => {
    expect(formatRelativeTime("2026-07-04T12:00:00.000Z", now)).toBe(
      "3 hours ago",
    );
  });

  it("humanizes days", () => {
    expect(formatRelativeTime("2026-07-01T15:00:00.000Z", now)).toBe(
      "3 days ago",
    );
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-date", now)).toBeNull();
  });

  it("treats a timestamp slightly in the future as 'just now' (clock skew)", () => {
    expect(formatRelativeTime("2026-07-04T15:00:05.000Z", now)).toBe(
      "just now",
    );
  });
});

describe("formatAbsoluteTime", () => {
  it("returns a formatted date/time string for a valid timestamp", () => {
    const result = formatAbsoluteTime("2026-07-04T12:29:27.897Z");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });

  it("returns null for an unparseable timestamp", () => {
    expect(formatAbsoluteTime("not-a-date")).toBeNull();
  });
});

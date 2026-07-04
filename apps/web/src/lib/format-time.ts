// Humanizes ISO timestamps for the machine-world data shown across the
// app (last-seen, created-at, etc.) -- "3 hours ago" rather than a raw
// `2026-07-04T12:29:27.897Z`. Callers should also set the exact
// formatAbsoluteTime() value as a `title` attribute so the precise moment
// is still available on hover/focus.
const MINUTE_MS = 60_000;
const UNITS: Array<{ unit: string; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * MINUTE_MS },
  { unit: "month", ms: 30 * 24 * 60 * MINUTE_MS },
  { unit: "week", ms: 7 * 24 * 60 * MINUTE_MS },
  { unit: "day", ms: 24 * 60 * MINUTE_MS },
  { unit: "hour", ms: 60 * MINUTE_MS },
  { unit: "minute", ms: MINUTE_MS },
];

// Returns null for unparseable input so callers can fall back to their own
// "unknown"/"never" copy instead of rendering "Invalid Date ago".
export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;

  const diffMs = now.getTime() - then.getTime();
  if (diffMs < MINUTE_MS) return "just now";
  if (diffMs < 0) return "just now";

  for (const { unit, ms } of UNITS) {
    const value = Math.floor(diffMs / ms);
    if (value >= 1) {
      return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
    }
  }

  return "just now";
}

export function formatAbsoluteTime(iso: string): string | null {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return then.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

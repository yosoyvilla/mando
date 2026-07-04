/**
 * Calculate the next reconnection delay with exponential backoff and full jitter.
 *
 * The delay is calculated using the formula:
 *   ceiling = min(60000, 1000 * 2^attempt)
 *   delay = 1000 + rand() * (ceiling - 1000)
 *
 * This ensures:
 * - At attempt 0: delay ranges from 1000ms to 1000ms (no jitter possible)
 * - At attempt 1: delay ranges from 1000ms to 2000ms
 * - At attempt N: delay ranges from 1000ms to min(60000ms, 1000 * 2^N)
 * - After ceiling hits the 60000ms cap, delay ranges from 1000ms to 60000ms
 *
 * @param attempt - The 0-based attempt number
 * @param rand - Optional random number generator (defaults to Math.random)
 * @returns The delay in milliseconds
 */
export function nextDelay(attempt: number, rand: () => number = Math.random): number {
  const base = 1000; // 1 second
  const cap = 60000; // 60 seconds

  const ceiling = Math.min(cap, base * Math.pow(2, attempt));
  const delay = base + rand() * (ceiling - base);

  return Math.floor(delay);
}

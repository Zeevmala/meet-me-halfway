/**
 * Exponential backoff delay, shared by the session retry helper and the
 * resource layer so the two cannot drift apart.
 */

export interface BackoffOptions {
  /** Delay for attempt 0; doubles from there. */
  readonly baseMs: number;
  /** Upper bound on the computed delay. */
  readonly maxMs?: number;
  /**
   * Spread retries over [50%, 100%] of the computed delay. Without it, N
   * clients that failed on the same upstream blip all retry in lockstep.
   */
  readonly jitter?: boolean;
  /** Injectable randomness; defaults to Math.random. */
  readonly random?: () => number;
}

export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions,
): number {
  const { baseMs, maxMs = Number.POSITIVE_INFINITY } = options;
  const raw = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  if (!options.jitter) return raw;
  const random = options.random ?? Math.random;
  return Math.round(raw * (0.5 + random() * 0.5));
}

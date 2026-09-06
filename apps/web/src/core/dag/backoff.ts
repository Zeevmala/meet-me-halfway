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
  /**
   * Server-mandated minimum, applied **after** jitter and after `maxMs`.
   *
   * A `Retry-After` is not a suggestion to be averaged with our own guess: a
   * dependency that said 30 s and is asked again at 1 s answers 429 again and
   * counts twice against the breaker. Jitter still applies above the floor, so
   * N clients holding the same hint do not resume in lockstep.
   */
  readonly floorMs?: number;
}

export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions,
): number {
  const { baseMs, maxMs = Number.POSITIVE_INFINITY, floorMs = 0 } = options;
  const raw = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  if (!options.jitter) return Math.max(raw, floorMs);
  const random = options.random ?? Math.random;
  return Math.max(Math.round(raw * (0.5 + random() * 0.5)), floorMs);
}

/**
 * Circuit breaker for effectful nodes.
 *
 * Deliberately **lazy**: it holds no timer. State transitions are decided by
 * comparing `openedAtMs + openMs` against a clock supplied at the call site.
 *
 * Two reasons that matters here. First, a timer-driven breaker reproduces the
 * bug this replaces — useDirections doubled a backoff on a 429, but the
 * movement guard returned before the timer was ever re-armed, so the failure
 * stuck until somebody walked 200 m. Recovery that depends on something else
 * firing is exactly the failure mode. Second, this is a PWA: backgrounded
 * mobile browsers throttle setTimeout to minutes and freeze it entirely under
 * bfcache, so a 60-second window silently becomes indefinite. A timestamp
 * comparison is immune to both.
 */

export type BreakerState = "closed" | "open" | "halfOpen";

export interface BreakerConfig {
  /** Consecutive failures that trip the breaker. */
  readonly failureThreshold: number;
  /** Cooldown applied the first time it opens. */
  readonly baseOpenMs: number;
  /** Ceiling for the cooldown after repeated half-open failures. */
  readonly maxOpenMs: number;
  /** Cooldown growth factor per failed probe. */
  readonly multiplier: number;
}

export interface Breaker {
  /**
   * Whether a call may proceed. Transitions `open → halfOpen` when the
   * cooldown has elapsed, admitting exactly one probe.
   */
  readonly allow: (nowMs: number) => boolean;
  readonly recordSuccess: () => void;
  readonly recordFailure: (nowMs: number) => void;
  readonly state: () => BreakerState;
  /** When the breaker will next admit a probe; `0` while closed. */
  readonly retryAtMs: () => number;
}

export function createBreaker(config: BreakerConfig): Breaker {
  let state: BreakerState = "closed";
  let failures = 0;
  let openedAtMs = 0;
  let openMs = config.baseOpenMs;

  function allow(nowMs: number): boolean {
    if (state === "closed") return true;
    if (state === "halfOpen") return false; // a probe is already out
    if (nowMs >= openedAtMs + openMs) {
      state = "halfOpen";
      return true;
    }
    return false;
  }

  function recordSuccess(): void {
    state = "closed";
    failures = 0;
    openMs = config.baseOpenMs;
  }

  function recordFailure(nowMs: number): void {
    if (state === "halfOpen") {
      // The probe failed: back off harder before the next one.
      state = "open";
      openedAtMs = nowMs;
      openMs = Math.min(openMs * config.multiplier, config.maxOpenMs);
      return;
    }
    failures += 1;
    if (failures >= config.failureThreshold) {
      state = "open";
      openedAtMs = nowMs;
      openMs = config.baseOpenMs;
    }
  }

  return {
    allow,
    recordSuccess,
    recordFailure,
    state: () => state,
    retryAtMs: () => (state === "closed" ? 0 : openedAtMs + openMs),
  };
}

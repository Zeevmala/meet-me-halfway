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
  /**
   * Open the breaker for an explicit window, clamped to the configured
   * bounds. The caller for this is a server that told us how long to wait —
   * a `Retry-After` longer than the retry loop is willing to sleep through
   * belongs here rather than inside a dispatch.
   */
  readonly openFor: (nowMs: number, ms: number) => void;
  readonly state: () => BreakerState;
  /**
   * When the breaker will next admit a probe; `0` when there is nothing to
   * wait for.
   *
   * `0` while **closed** (calls already pass) and also while **halfOpen** (a
   * probe is out; its result is what moves the state). Returning the elapsed
   * `openedAt + openMs` in the half-open case put a *past* instant in front of
   * the caller: `resource.shouldDispatch` read it as "cooldown over, dispatch",
   * `fire()` was then refused by `allow()`, and `scheduleBreakerWake` re-armed
   * at `max(0, past - now)` = 0 — an unbounded `setTimeout(…, 0)` spin for the
   * whole lifetime of the probe, on exactly the degraded network that opened
   * the breaker.
   */
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
    // Already open: calls are being refused, so there is nothing to count.
    // Falling through would restart the window at `baseOpenMs` and silently
    // shrink an explicit `openFor` cooldown back to the default.
    if (state === "open") return;
    failures += 1;
    if (failures >= config.failureThreshold) {
      state = "open";
      openedAtMs = nowMs;
      openMs = config.baseOpenMs;
    }
  }

  function openFor(nowMs: number, ms: number): void {
    state = "open";
    openedAtMs = nowMs;
    failures = config.failureThreshold;
    openMs = Math.min(Math.max(ms, config.baseOpenMs), config.maxOpenMs);
  }

  return {
    allow,
    recordSuccess,
    recordFailure,
    openFor,
    state: () => state,
    retryAtMs: () => (state === "open" ? openedAtMs + openMs : 0),
  };
}

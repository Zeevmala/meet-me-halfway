/**
 * One combinator for every effectful node: debounce with a starvation
 * ceiling, admission control, in-flight de-duplication, abort, timeout,
 * retry, circuit breaking, and last-known-good serving.
 *
 * It exists because the same concerns were previously re-implemented per hook
 * with subtly different — and in places broken — semantics.
 *
 * Two distinct predicates, which the previous code conflated:
 *
 *  - `admits` is **metric and stateful**: it compares the new input against
 *    the last input actually dispatched. "Is this difference worth a call?"
 *  - `identity` is **pure and current-input-only**: it collapses concurrent
 *    duplicate requests. "Are these the same request?"
 *
 * Quantising coordinates into grid cells is fine for `identity` (a collision
 * merely skips a duplicate) but must never gate admission: a stationary user
 * whose GPS noise straddles a cell boundary would flip cells at ~1 Hz and pay
 * for one API call per second forever. A displacement-from-last-accepted
 * predicate structurally cannot do that, because its baseline advances with
 * each accepted call.
 */
import { createBreaker } from "./breaker";
import type { BreakerConfig } from "./breaker";
import { backoffDelayMs } from "./backoff";
import { err } from "./result";
import type { Result } from "./result";
import {
  classifyThrown,
  countsAgainstBreaker,
  isRetryableError,
} from "./errors";
import type { ResourceError } from "./errors";

export type TimerId = ReturnType<typeof setTimeout>;

/** Injected I/O seam, so tests drive time instead of mocking globals. */
export interface ResourcePorts {
  readonly now: () => number;
  readonly schedule: (fn: () => void, ms: number) => TimerId;
  readonly cancel: (id: TimerId) => void;
}

export type ResourceStatus =
  "idle" | "pending" | "ready" | "degraded" | "failed";

export interface ResourceState<O> {
  readonly status: ResourceStatus;
  /** What consumers should render. Falls back to `lastGood` while degraded. */
  readonly value: O | null;
  readonly lastGood: O | null;
  readonly lastGoodAtMs: number | null;
  readonly error: ResourceError | null;
  /** True when `value` did not come from the most recent attempt. */
  readonly stale: boolean;
}

export interface ResourcePolicy<I, O> {
  readonly id: string;
  /** Trailing debounce applied to input churn. */
  readonly debounceMs: number;
  /**
   * Hard ceiling from the first pending input. Inputs arrive at GPS rate, so
   * a purely trailing debounce is reset before it can ever fire — the reason
   * the first fetch could be starved indefinitely while a user was walking.
   */
  readonly maxWaitMs: number;
  /** Per-attempt deadline; `0` disables. */
  readonly timeoutMs: number;
  /** Beyond this age a last-good value is dropped rather than served. */
  readonly staleAfterMs: number;
  readonly retryAttempts: number;
  readonly retryBaseMs: number;
  readonly breaker: BreakerConfig;
  readonly admits: (
    previous: I,
    next: I,
    previousAtMs: number,
    nowMs: number,
  ) => boolean;
  readonly identity: (input: I) => string;
  readonly run: (
    input: I,
    signal: AbortSignal,
  ) => Promise<Result<O, ResourceError>>;
}

export interface Resource<I, O> {
  /** Offer the current input. `null` means "no valid input right now". */
  readonly request: (input: I | null) => void;
  readonly getState: () => ResourceState<O>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

const IDLE = {
  status: "idle" as const,
  value: null,
  lastGood: null,
  lastGoodAtMs: null,
  error: null,
  stale: false,
};

export function createResource<I, O>(
  policy: ResourcePolicy<I, O>,
  ports: ResourcePorts,
): Resource<I, O> {
  const breaker = createBreaker(policy.breaker);
  const listeners = new Set<() => void>();

  let state: ResourceState<O> = IDLE;
  let pendingInput: I | null = null;
  let firstPendingAtMs: number | null = null;
  let timer: TimerId | null = null;
  let acceptedInput: I | null = null;
  let acceptedAtMs = 0;
  let inFlightIdentity: string | null = null;
  let controller: AbortController | null = null;
  let epoch = 0;
  let disposed = false;

  function emit(next: ResourceState<O>): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function clearTimer(): void {
    if (timer !== null) {
      ports.cancel(timer);
      timer = null;
    }
  }

  function shouldDispatch(input: I, nowMs: number): boolean {
    // An identical request is already out; its answer will be ours too.
    // Without this, the "pending" notification re-enters through a consumer
    // and arms a second call before acceptedInput has been set, so every
    // fetch is issued twice.
    if (
      inFlightIdentity !== null &&
      policy.identity(input) === inFlightIdentity
    ) {
      return false;
    }
    if (acceptedInput === null) return true;
    if (policy.admits(acceptedInput, input, acceptedAtMs, nowMs)) return true;
    // A stationary user must still recover from an outage, so an elapsed
    // breaker cooldown is itself a reason to dispatch. Without this the
    // breaker could only recover if the input happened to change.
    const retryAt = breaker.retryAtMs();
    return retryAt !== 0 && nowMs >= retryAt;
  }

  function arm(nowMs: number): void {
    clearTimer();
    const waited = nowMs - (firstPendingAtMs ?? nowMs);
    const delay = Math.max(
      0,
      Math.min(policy.debounceMs, policy.maxWaitMs - waited),
    );
    timer = ports.schedule(() => void fire(), delay);
  }

  /** Backstop wake so recovery does not depend on inputs continuing to tick. */
  function scheduleBreakerWake(nowMs: number): void {
    const retryAt = breaker.retryAtMs();
    if (retryAt === 0) return;
    clearTimer();
    firstPendingAtMs = nowMs;
    timer = ports.schedule(() => void fire(), Math.max(0, retryAt - nowMs));
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const id = ports.schedule(() => resolve(), ms);
      signal.addEventListener(
        "abort",
        () => {
          ports.cancel(id);
          resolve();
        },
        { once: true },
      );
    });
  }

  function withTimeout(
    input: I,
    signal: AbortSignal,
  ): Promise<Result<O, ResourceError>> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<O, ResourceError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timeoutId =
        policy.timeoutMs > 0
          ? ports.schedule(
              () => finish(err({ kind: "TIMEOUT", afterMs: policy.timeoutMs })),
              policy.timeoutMs,
            )
          : null;
      policy.run(input, signal).then(
        (result) => {
          if (timeoutId !== null) ports.cancel(timeoutId);
          finish(result);
        },
        (thrown: unknown) => {
          if (timeoutId !== null) ports.cancel(timeoutId);
          finish(err(classifyThrown(thrown)));
        },
      );
    });
  }

  async function attempt(
    input: I,
    signal: AbortSignal,
  ): Promise<Result<O, ResourceError>> {
    const attempts = Math.max(1, policy.retryAttempts);
    let last: Result<O, ResourceError> = err({
      kind: "NETWORK",
      detail: "not attempted",
    });
    for (let i = 0; i < attempts; i++) {
      if (signal.aborted) return last;
      last = await withTimeout(input, signal);
      if (last.ok || !isRetryableError(last.error) || i === attempts - 1) {
        return last;
      }
      await sleep(
        backoffDelayMs(i, { baseMs: policy.retryBaseMs, jitter: true }),
        signal,
      );
    }
    return last;
  }

  async function fire(): Promise<void> {
    timer = null;
    firstPendingAtMs = null;
    const input = pendingInput;
    if (input === null || disposed) return;

    const startedAtMs = ports.now();
    if (!breaker.allow(startedAtMs)) {
      emit(degrade({ kind: "OPEN_CIRCUIT", retryAtMs: breaker.retryAtMs() }));
      scheduleBreakerWake(startedAtMs);
      return;
    }

    const identity = policy.identity(input);
    // An identical request is already out; its answer will be ours too.
    if (identity === inFlightIdentity) return;

    if (controller !== null) controller.abort();
    const active = new AbortController();
    controller = active;
    inFlightIdentity = identity;
    const myEpoch = ++epoch;

    emit({ ...state, status: "pending" });

    const result = await attempt(input, active.signal);

    // Superseded, torn down, or aborted: the newer run owns the state.
    if (myEpoch !== epoch || disposed || active.signal.aborted) return;
    inFlightIdentity = null;

    const settledAtMs = ports.now();
    if (result.ok) {
      breaker.recordSuccess();
      acceptedInput = input;
      acceptedAtMs = settledAtMs;
      emit({
        status: "ready",
        value: result.value,
        lastGood: result.value,
        lastGoodAtMs: settledAtMs,
        error: null,
        stale: false,
      });
      // The input may have moved on while this request was in flight; the
      // consumer will not necessarily offer it again on its own.
      if (pendingInput !== null && pendingInput !== input) {
        request(pendingInput);
      }
      return;
    }

    if (countsAgainstBreaker(result.error)) breaker.recordFailure(settledAtMs);
    emit(degrade(result.error, settledAtMs));
    scheduleBreakerWake(settledAtMs);
  }

  /**
   * Keep serving the last good value rather than blanking the UI — but only
   * while it is young enough to still be true. A stale route is a confident
   * lie; falling back to nothing lets the UI show an honest straight line.
   */
  function degrade(
    error: ResourceError,
    nowMs: number = ports.now(),
  ): ResourceState<O> {
    const usable =
      state.lastGood !== null &&
      state.lastGoodAtMs !== null &&
      nowMs - state.lastGoodAtMs <= policy.staleAfterMs;
    return {
      status: usable ? "degraded" : "failed",
      value: usable ? state.lastGood : null,
      lastGood: state.lastGood,
      lastGoodAtMs: state.lastGoodAtMs,
      error,
      stale: true,
    };
  }

  function request(input: I | null): void {
    if (disposed) return;
    if (input === null) {
      pendingInput = null;
      firstPendingAtMs = null;
      clearTimer();
      return;
    }
    const nowMs = ports.now();
    pendingInput = input;
    if (!shouldDispatch(input, nowMs)) return;
    if (firstPendingAtMs === null) firstPendingAtMs = nowMs;
    arm(nowMs);
  }

  return {
    request,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      if (controller !== null) controller.abort();
      listeners.clear();
    },
  };
}

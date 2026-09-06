import { describe, it, expect, vi } from "vitest";
import { createResource } from "./resource";
import type { ResourcePolicy, ResourcePorts, TimerId } from "./resource";
import { ok, err } from "./result";
import type { Result } from "./result";
import type { ResourceError } from "./errors";

/**
 * Virtual clock + scheduler. The resource takes both as ports, so these tests
 * drive time directly and never touch fake timers or global mocks.
 */
function createTestPorts() {
  let nowMs = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  const ports: ResourcePorts = {
    now: () => nowMs,
    schedule: (fn, ms) => {
      const id = ++nextId;
      tasks.set(id, { at: nowMs + ms, fn });
      return id as unknown as TimerId;
    },
    cancel: (id) => {
      tasks.delete(id as unknown as number);
    },
  };

  /** Let queued promise callbacks run. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  const advance = async (ms: number): Promise<void> => {
    const target = nowMs + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueId = id;
          dueAt = task.at;
        }
      }
      if (dueId === null) break;
      const task = tasks.get(dueId);
      tasks.delete(dueId);
      nowMs = dueAt;
      task?.fn();
      await flush();
    }
    nowMs = target;
    await flush();
  };

  return {
    ports,
    advance,
    flush,
    now: () => nowMs,
    /** Timers currently armed. A spin shows up here as work that never drains. */
    pending: () => tasks.size,
  };
}

interface Input {
  readonly at: number;
  readonly tag: string;
}

function makePolicy(
  run: (
    input: Input,
    signal: AbortSignal,
  ) => Promise<Result<string, ResourceError>>,
  overrides: Partial<ResourcePolicy<Input, string>> = {},
): ResourcePolicy<Input, string> {
  return {
    id: "test",
    debounceMs: 1000,
    maxWaitMs: 3000,
    timeoutMs: 0,
    staleAfterMs: 60_000,
    retryAttempts: 1,
    retryBaseMs: 100,
    breaker: {
      failureThreshold: 2,
      baseOpenMs: 5000,
      maxOpenMs: 20_000,
      multiplier: 2,
    },
    // "Moved far enough to be worth a call."
    admits: (previous, next) => Math.abs(next.at - previous.at) >= 10,
    identity: (input) => input.tag,
    run,
    ...overrides,
  };
}

const RATE_LIMITED: ResourceError = { kind: "RATE_LIMITED", retryAfterMs: 0 };

describe("createResource", () => {
  it("debounces a burst of inputs into one call", async () => {
    const run = vi.fn().mockResolvedValue(ok("v1"));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    r.request({ at: 0, tag: "a" });
    r.request({ at: 1, tag: "a" });
    r.request({ at: 2, tag: "a" });
    expect(run).not.toHaveBeenCalled();

    await t.advance(1000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(r.getState().value).toBe("v1");
    expect(r.getState().status).toBe("ready");
  });

  // Regression: both fetch hooks reset their debounce on every dependency
  // change, and dependencies changed at GPS rate. While a user was walking,
  // the timer was cleared before it could ever fire and the first fetch was
  // starved indefinitely.
  it("fires at the maxWait ceiling under continuous input churn", async () => {
    const t = createTestPorts();
    let firstCallAtMs = -1;
    const run = vi.fn().mockImplementation(() => {
      if (firstCallAtMs < 0) firstCallAtMs = t.now();
      return Promise.resolve(ok("v1"));
    });
    const r = createResource(makePolicy(run), t.ports);

    // An input every 500ms — each one resets a 1000ms trailing debounce, so
    // without the ceiling the timer would never survive long enough to fire.
    for (let i = 0; i < 10; i++) {
      r.request({ at: i * 100, tag: "a" });
      await t.advance(500);
    }

    expect(run).toHaveBeenCalled();
    expect(firstCallAtMs).toBeGreaterThanOrEqual(0);
    expect(firstCallAtMs).toBeLessThanOrEqual(3000);
  });

  it("suppresses a call when the input has not moved far enough", async () => {
    const run = vi.fn().mockResolvedValue(ok("v1"));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // Within the admission threshold: no second call.
    r.request({ at: 5, tag: "b" });
    await t.advance(5000);
    expect(run).toHaveBeenCalledTimes(1);

    // Beyond it: dispatched.
    r.request({ at: 100, tag: "c" });
    await t.advance(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("collapses a duplicate request already in flight", async () => {
    let release: (v: Result<string, ResourceError>) => void = () => {};
    const run = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    r.request({ at: 0, tag: "same" });
    await t.advance(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // Same identity while the first is still out: no second call.
    r.request({ at: 100, tag: "same" });
    await t.advance(1000);
    expect(run).toHaveBeenCalledTimes(1);

    release(ok("v1"));
    await t.flush();
    expect(r.getState().value).toBe("v1");
  });

  it("serves the last good value while degraded", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok("good"))
      .mockResolvedValue(err(RATE_LIMITED));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    expect(r.getState().value).toBe("good");

    r.request({ at: 100, tag: "b" });
    await t.advance(1000);

    const s = r.getState();
    expect(s.status).toBe("degraded");
    expect(s.value).toBe("good");
    expect(s.stale).toBe(true);
    expect(s.error).toEqual(RATE_LIMITED);
  });

  it("drops a last good value that has aged past staleAfterMs", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(ok("good"))
      .mockResolvedValue(err(RATE_LIMITED));
    const t = createTestPorts();
    const r = createResource(makePolicy(run, { staleAfterMs: 2000 }), t.ports);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    expect(r.getState().value).toBe("good");

    await t.advance(10_000);
    r.request({ at: 100, tag: "b" });
    await t.advance(1000);

    const s = r.getState();
    expect(s.status).toBe("failed");
    expect(s.value).toBeNull();
    expect(s.lastGood).toBe("good");
  });

  // Regression: a 429 doubled the *debounce delay*, but the movement guard
  // returned before the timer was re-armed. With a stationary user the
  // failure was permanent — nothing ever retried.
  it("recovers after the breaker cooldown with no input change", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(err(RATE_LIMITED))
      .mockResolvedValueOnce(err(RATE_LIMITED))
      .mockResolvedValue(ok("recovered"));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    // Two failures trip the breaker.
    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    r.request({ at: 100, tag: "b" });
    await t.advance(1000);
    expect(r.getState().status).toBe("failed");

    const callsBefore = run.mock.calls.length;

    // No further input at all — a stationary user. The backstop wake must
    // still drive recovery once the cooldown elapses.
    await t.advance(20_000);

    expect(run.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(r.getState().status).toBe("ready");
    expect(r.getState().value).toBe("recovered");
  });

  it("retries a retryable failure and reports the recovered value", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(err({ kind: "HTTP", status: 503 }))
      .mockResolvedValue(ok("second-try"));
    const t = createTestPorts();
    const r = createResource(
      makePolicy(run, { retryAttempts: 3, retryBaseMs: 100 }),
      t.ports,
    );

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    await t.advance(500);

    expect(run).toHaveBeenCalledTimes(2);
    expect(r.getState().value).toBe("second-try");
  });

  it("does not retry a failure that cannot succeed on retry", async () => {
    const run = vi.fn().mockResolvedValue(err({ kind: "HTTP", status: 400 }));
    const t = createTestPorts();
    const r = createResource(
      makePolicy(run, { retryAttempts: 3, retryBaseMs: 100 }),
      t.ports,
    );

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    await t.advance(1000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(r.getState().status).toBe("failed");
  });

  it("reports a timeout when the call outlives its deadline", async () => {
    const run = vi.fn().mockImplementation(() => new Promise(() => {}));
    const t = createTestPorts();
    const r = createResource(makePolicy(run, { timeoutMs: 2000 }), t.ports);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    await t.advance(2000);

    expect(r.getState().error).toEqual({ kind: "TIMEOUT", afterMs: 2000 });
  });

  it("notifies subscribers and stops after dispose", async () => {
    const run = vi.fn().mockResolvedValue(ok("v1"));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);
    const listener = vi.fn();
    r.subscribe(listener);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);
    expect(listener).toHaveBeenCalled();

    const callsAfterDispose = run.mock.calls.length;
    r.dispose();
    r.request({ at: 500, tag: "b" });
    await t.advance(5000);
    expect(run.mock.calls.length).toBe(callsAfterDispose);
  });

  it("returns a referentially stable snapshot between changes", async () => {
    const run = vi.fn().mockResolvedValue(ok("v1"));
    const t = createTestPorts();
    const r = createResource(makePolicy(run), t.ports);

    r.request({ at: 0, tag: "a" });
    await t.advance(1000);

    expect(r.getState()).toBe(r.getState());
  });
});

describe("createResource — breaker interaction", () => {
  it("does not re-arm while a half-open probe is outstanding", async () => {
    const clock = createTestPorts();
    let resolveProbe: ((r: Result<string, ResourceError>) => void) | null =
      null;
    let calls = 0;

    const resource = createResource(
      makePolicy((_input) => {
        calls++;
        // The first two calls fail outright and trip the breaker
        // (failureThreshold: 2). The third is the half-open probe, which we
        // hold open so the breaker stays in `halfOpen`.
        if (calls <= 2) {
          return Promise.resolve(
            err({ kind: "NETWORK", detail: "down" }) as Result<
              string,
              ResourceError
            >,
          );
        }
        return new Promise<Result<string, ResourceError>>((resolve) => {
          resolveProbe = resolve;
        });
      }),
      clock.ports,
    );

    resource.request({ at: 0, tag: "a" });
    await clock.advance(1000);
    resource.request({ at: 20, tag: "b" });
    await clock.advance(1000);
    expect(resource.getState().error?.kind).toBe("NETWORK");

    // Cooldown elapses; exactly one probe goes out and stays out.
    await clock.advance(5000);
    expect(calls).toBe(3);
    expect(resolveProbe).not.toBeNull();

    // A moved input arrives while the probe is still in flight. The breaker
    // refuses it — and must not schedule a wake for an instant already in the
    // past, which is how this became an unbounded setTimeout(fire, 0) chain.
    resource.request({ at: 200, tag: "c" });
    await clock.advance(1000);

    expect(calls).toBe(3);
    expect(resource.getState().error?.kind).toBe("OPEN_CIRCUIT");
    expect(clock.pending()).toBe(0);
  });
});

describe("createResource — Retry-After", () => {
  it("waits at least as long as the server asked before retrying", async () => {
    const clock = createTestPorts();
    const attemptAt: number[] = [];

    const resource = createResource(
      makePolicy(
        () => {
          attemptAt.push(clock.now());
          return Promise.resolve(
            err({ kind: "RATE_LIMITED", retryAfterMs: 600 }) as Result<
              string,
              ResourceError
            >,
          );
        },
        { retryAttempts: 2, retryBaseMs: 100 },
      ),
      clock.ports,
    );

    resource.request({ at: 0, tag: "a" });
    await clock.advance(1000);
    expect(attemptAt).toEqual([1000]);

    // Plain exponential backoff would have retried at ~100ms. The hint floors
    // it at 600ms, so nothing happens before then.
    await clock.advance(599);
    expect(attemptAt).toEqual([1000]);

    await clock.advance(1);
    expect(attemptAt).toEqual([1000, 1600]);
  });

  it("hands a long Retry-After to the breaker instead of sleeping on it", async () => {
    const clock = createTestPorts();
    let calls = 0;

    const resource = createResource(
      makePolicy(
        () => {
          calls++;
          return Promise.resolve(
            err({ kind: "RATE_LIMITED", retryAfterMs: 30_000 }) as Result<
              string,
              ResourceError
            >,
          );
        },
        { retryAttempts: 3, retryBaseMs: 100 },
      ),
      clock.ports,
    );

    resource.request({ at: 0, tag: "a" });
    await clock.advance(1000);

    // 30s is far past retryBaseMs * 8; the dispatch ends after one attempt
    // rather than pinning a controller for half a minute.
    expect(calls).toBe(1);
    expect(resource.getState().error?.kind).toBe("RATE_LIMITED");

    // The window is the breaker's now — clamped to maxOpenMs (20s here) — and
    // a later failure must not shrink it back to baseOpenMs.
    resource.request({ at: 500, tag: "b" });
    await clock.advance(19_000);
    expect(calls).toBe(1);
    expect(resource.getState().error?.kind).toBe("OPEN_CIRCUIT");

    await clock.advance(2000);
    expect(calls).toBe(2);
  });
});

describe("createResource — timeout cancels its request", () => {
  it("aborts the attempt that timed out and gives the retry a fresh signal", async () => {
    const clock = createTestPorts();
    const signals: AbortSignal[] = [];

    const resource = createResource(
      makePolicy(
        (_input, signal) => {
          signals.push(signal);
          // Never settles: only the deadline can end this attempt.
          return new Promise<Result<string, ResourceError>>(() => {});
        },
        { timeoutMs: 500, retryAttempts: 2, retryBaseMs: 100 },
      ),
      clock.ports,
    );

    resource.request({ at: 0, tag: "a" });
    await clock.advance(1000);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    // The deadline must cancel the in-flight request, not merely stop waiting
    // for it — otherwise the retry runs alongside it on a second socket.
    await clock.advance(500);
    expect(signals[0].aborted).toBe(true);

    await clock.advance(200);
    expect(signals).toHaveLength(2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1].aborted).toBe(false);
  });

  it("aborts the live attempt when the dispatch is superseded", async () => {
    const clock = createTestPorts();
    const signals: AbortSignal[] = [];

    const resource = createResource(
      makePolicy(
        (_input, signal) => {
          signals.push(signal);
          return new Promise<Result<string, ResourceError>>(() => {});
        },
        { timeoutMs: 0, retryAttempts: 1 },
      ),
      clock.ports,
    );

    resource.request({ at: 0, tag: "a" });
    await clock.advance(1000);
    expect(signals).toHaveLength(1);

    resource.request({ at: 500, tag: "b" });
    await clock.advance(1000);

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
  });
});

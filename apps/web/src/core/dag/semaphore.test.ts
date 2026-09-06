import { describe, it, expect } from "vitest";
import { createSemaphore, withPermit } from "./semaphore";
import type { Release } from "./semaphore";

/** Let queued promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const never = new AbortController().signal;

describe("createSemaphore", () => {
  it("admits up to the limit without waiting", async () => {
    const sem = createSemaphore(2);
    await sem.acquire(never);
    await sem.acquire(never);
    expect(sem.inFlight()).toBe(2);
  });

  it("queues past the limit and never exceeds it", async () => {
    const sem = createSemaphore(2);
    const held: Release[] = [];
    let granted = 0;

    for (let i = 0; i < 5; i++) {
      void sem.acquire(never).then((release) => {
        granted++;
        held.push(release);
      });
    }
    await flush();

    expect(granted).toBe(2);
    expect(sem.inFlight()).toBe(2);

    held.shift()?.();
    await flush();
    expect(granted).toBe(3);
    expect(sem.inFlight()).toBe(2);
  });

  it("hands permits out in FIFO order", async () => {
    const sem = createSemaphore(1);
    const first = await sem.acquire(never);
    const order: number[] = [];

    for (const n of [1, 2, 3]) {
      void sem.acquire(never).then((release) => {
        order.push(n);
        release();
      });
    }
    await flush();
    expect(order).toEqual([]);

    first();
    await flush();
    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects a queued waiter on abort without consuming a permit", async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire(never);

    const controller = new AbortController();
    const queued = sem.acquire(controller.signal);
    const outcome: string[] = [];
    void queued.catch((e: unknown) => {
      outcome.push((e as DOMException).name);
    });

    controller.abort();
    await flush();
    expect(outcome).toEqual(["AbortError"]);

    // The abandoned waiter must not have taken the permit with it.
    held();
    await flush();
    expect(sem.inFlight()).toBe(0);
    await sem.acquire(never);
    expect(sem.inFlight()).toBe(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const sem = createSemaphore(1);
    const controller = new AbortController();
    controller.abort();

    await expect(sem.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(sem.inFlight()).toBe(0);
  });

  it("ignores a double release", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire(never);
    release();
    release();
    expect(sem.inFlight()).toBe(0);

    // Capacity must still be 1: the second acquire has to queue, not resolve.
    await sem.acquire(never);
    let secondGranted = false;
    void sem.acquire(never).then(() => {
      secondGranted = true;
    });
    await flush();
    expect(secondGranted).toBe(false);
    expect(sem.inFlight()).toBe(1);
  });
});

describe("withPermit", () => {
  it("bounds concurrency of the wrapped call", async () => {
    const sem = createSemaphore(2);
    let live = 0;
    let peak = 0;
    const settle: (() => void)[] = [];

    const guarded = withPermit(
      sem,
      (_url: string, _signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          live++;
          peak = Math.max(peak, live);
          settle.push(() => {
            live--;
            resolve("done");
          });
        }),
    );

    const calls = [0, 1, 2, 3].map((i) => guarded(`u${i}`, never));
    await flush();
    expect(peak).toBe(2);

    while (settle.length > 0) {
      settle.shift()?.();
      await flush();
    }
    await Promise.all(calls);
    expect(peak).toBe(2);
    expect(sem.inFlight()).toBe(0);
  });

  it("releases the permit when the wrapped call rejects", async () => {
    const sem = createSemaphore(1);
    const guarded = withPermit(sem, (_signal: AbortSignal) =>
      Promise.reject(new Error("boom")),
    );

    await expect(guarded(never)).rejects.toThrow("boom");
    expect(sem.inFlight()).toBe(0);
  });
});

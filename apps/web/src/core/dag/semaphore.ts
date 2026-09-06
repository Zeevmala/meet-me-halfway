/**
 * FIFO counting semaphore — the bulkhead across effectful nodes.
 *
 * Each resource owns a circuit breaker, but a breaker is a *reactive* control:
 * it only closes the tap after failures have already been paid for. Nothing
 * bounded total in-flight I/O, and the peak is not small — one route dispatch
 * fans out per occupied slot, so five participants plus a venue search put six
 * requests on the wire at once, against a six-per-host HTTP/1.1 connection cap
 * that the RTDB WebSocket and Mapbox tile fetches are also drawing on.
 *
 * Queueing is FIFO rather than LIFO deliberately. A resource that has already
 * been admitted past its debounce represents a decision to spend a call; the
 * newest request is not automatically the most valuable, and LIFO would let a
 * fast-ticking node starve a slow one indefinitely.
 */

/** Returns the permit. Idempotent — a double release cannot inflate the pool. */
export type Release = () => void;

export interface Semaphore {
  /**
   * Wait for a permit. Rejects with `AbortError` if `signal` fires first,
   * matching how `fetch` reports the same cancellation, so callers need only
   * one abort path.
   */
  readonly acquire: (signal: AbortSignal) => Promise<Release>;
  /** Permits currently held. Diagnostics and tests only. */
  readonly inFlight: () => number;
}

export function createSemaphore(limit: number): Semaphore {
  const capacity = Math.max(1, Math.floor(limit));
  let available = capacity;
  const waiters: (() => void)[] = [];

  function makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      // Hand the permit straight to the next waiter rather than returning it
      // to the pool: incrementing first would let a caller arriving in the
      // same turn jump the queue.
      if (next !== undefined) next();
      else available++;
    };
  }

  function acquire(signal: AbortSignal): Promise<Release> {
    return new Promise<Release>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (available > 0) {
        available--;
        resolve(makeRelease());
        return;
      }

      const grant = (): void => {
        signal.removeEventListener("abort", cancel);
        resolve(makeRelease());
      };
      const cancel = (): void => {
        const index = waiters.indexOf(grant);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };

      waiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  return { acquire, inFlight: () => capacity - available };
}

/**
 * Wrap an abortable async call so it holds a permit for its duration.
 *
 * Applied at the composition root rather than inside a `ResourcePolicy`, so
 * policies stay declarative records with no knowledge of global scheduling.
 */
export function withPermit<A extends readonly unknown[], R>(
  semaphore: Semaphore,
  fn: (...args: [...A, AbortSignal]) => Promise<R>,
): (...args: [...A, AbortSignal]) => Promise<R> {
  return async (...args: [...A, AbortSignal]): Promise<R> => {
    const signal = args[args.length - 1] as AbortSignal;
    const release = await semaphore.acquire(signal);
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}

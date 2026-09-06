/**
 * React bindings for the graph runtime.
 *
 * One `useSyncExternalStore` subscription replaces the four-hook render
 * cascade the page used to run, and because the snapshot is a single object
 * that only changes when a value actually changed, React commits it
 * atomically — no tearing, and the `memo()` on the cards finally holds.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRuntime } from "./runtime";
import type { GraphRuntime, GraphSnapshot } from "./runtime";
import type { GraphPorts } from "./ports";

/**
 * Own a runtime for the lifetime of the component.
 *
 * `ports` is required rather than defaulted. A default meant the page silently
 * built its own I/O seam while a test that thought it had injected one was
 * driving something else, and it put an `import.meta.env` read behind a
 * function nobody had to pass anything to.
 *
 * StrictMode in development mounts, tears down, then remounts. That teardown
 * disposes the runtime while the component keeps living, which would leave
 * `npm run dev` driving a dead graph — so if the runtime we hold has been
 * disposed, stand up a replacement. In production the effect runs once and
 * this never fires.
 */
export function useGraphRuntime(ports: GraphPorts): GraphRuntime {
  const [runtime, setRuntime] = useState<GraphRuntime>(() =>
    createRuntime(ports),
  );

  useEffect(() => {
    if (runtime.isDisposed()) {
      setRuntime(createRuntime(ports));
      return;
    }
    return () => runtime.dispose();
  }, [runtime, ports]);

  return runtime;
}

/** Subscribe to the runtime's atomic snapshot. */
export function useGraph(runtime: GraphRuntime): GraphSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
}

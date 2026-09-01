/**
 * React bindings for the graph runtime.
 *
 * One `useSyncExternalStore` subscription replaces the four-hook render
 * cascade the page used to run, and because the snapshot is a single object
 * that only changes when a value actually changed, React commits it
 * atomically — no tearing, and the `memo()` on the cards finally holds.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createRuntime } from "./runtime";
import type { GraphRuntime, GraphSnapshot } from "./runtime";
import { createDefaultPorts } from "./ports";
import type { GraphPorts } from "./ports";

/**
 * Own a runtime for the lifetime of the component.
 *
 * StrictMode in development mounts, tears down, then remounts. That teardown
 * disposes the runtime while the component keeps living, which would leave
 * `npm run dev` driving a dead graph — so if the runtime we hold has been
 * disposed, stand up a replacement. In production the effect runs once and
 * this never fires.
 */
export function useGraphRuntime(ports?: GraphPorts): GraphRuntime {
  const resolvedPorts = useMemo(() => ports ?? createDefaultPorts(), [ports]);
  const [runtime, setRuntime] = useState<GraphRuntime>(() =>
    createRuntime(resolvedPorts),
  );

  useEffect(() => {
    if (runtime.isDisposed()) {
      setRuntime(createRuntime(resolvedPorts));
      return;
    }
    return () => runtime.dispose();
  }, [runtime, resolvedPorts]);

  return runtime;
}

/** Subscribe to the runtime's atomic snapshot. */
export function useGraph(runtime: GraphRuntime): GraphSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
}

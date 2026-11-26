/**
 * The pipeline's dependency graph, declared in one place.
 *
 * Previously these edges existed only as `useMemo`/`useEffect` dependency
 * arrays spread across four hooks and a page component, where nothing could
 * check them. Declaring them explicitly buys a compile-time node set and a
 * runtime acyclicity check.
 *
 * That check is the durable payoff. There is no cycle today, but there is one
 * waiting: re-centring venue search on the selected venue, or balancing the
 * meeting point from the durations of the routes drawn to it, both close the
 * loop `meeting → venues → destination → routes → meeting`. (The `meeting`
 * node balances by time without it: it asks a matrix about candidate points.) Either would be a hang or an
 * infinite render, discovered at runtime on a phone. Here it is a failed test.
 */

export type NodeId =
  | "liveness"
  | "slots"
  | "presence"
  | "midpoint"
  | "meeting"
  | "phase"
  | "venues"
  | "destination"
  | "routes"
  | "frame";

/** `node: [its dependencies]`. */
export type EdgeMap = Readonly<Record<NodeId, readonly NodeId[]>>;

export const EDGES: EdgeMap = {
  // Reads sources and the clock only. It runs before `slots` because the slot
  // vector carries the staleness it derives — keeping `stale` a boolean in the
  // vector rather than a raw `lastSeen` is what lets `sameSlots` treat a
  // heartbeat from a stationary participant as no change at all.
  liveness: [],
  slots: ["liveness"],
  // A write, and a sink: nothing derives from its value. It follows `meeting`
  // because the creator's record carries the point that node worked out.
  presence: ["meeting"],
  midpoint: ["slots"],
  phase: ["slots", "liveness", "presence"],
  // The point balanced by travel time — worked out by the creator's device,
  // read by everyone else from the creator's record — falling back to the
  // centroid `midpoint` derives. It reads people's positions, never route durations or the
  // destination, which is what keeps the cycle the header warns of open:
  // nothing downstream of `meeting` feeds it.
  meeting: ["slots", "midpoint"],
  venues: ["meeting"],
  destination: ["meeting", "venues"],
  routes: ["slots", "destination"],
  frame: [
    "slots",
    "presence",
    "liveness",
    "midpoint",
    "meeting",
    "phase",
    "venues",
    "destination",
    "routes",
  ],
};

/**
 * Kahn's algorithm. Returns a topological order, or throws naming the nodes
 * involved.
 *
 * @throws if a dependency is not a declared node, or if a cycle exists.
 */
export function assertAcyclic(edges: EdgeMap): readonly NodeId[] {
  const ids = Object.keys(edges) as NodeId[];
  const known = new Set<NodeId>(ids);
  const indegree = new Map<NodeId, number>();
  const dependents = new Map<NodeId, NodeId[]>();

  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const id of ids) {
    for (const dep of edges[id]) {
      if (!known.has(dep)) {
        throw new Error(`Unknown dependency "${dep}" declared by node "${id}"`);
      }
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      dependents.get(dep)?.push(id);
    }
  }

  // Seed deterministically so the order is reproducible across runs.
  const ready = ids.filter((id) => indegree.get(id) === 0).sort();
  const order: NodeId[] = [];

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length !== ids.length) {
    const cyclic = ids.filter((id) => !order.includes(id)).sort();
    throw new Error(`Dependency cycle among: ${cyclic.join(", ")}`);
  }

  return order;
}

/** Topological order of the live-midpoint graph, validated at module load. */
export const TOPO_ORDER: readonly NodeId[] = assertAcyclic(EDGES);

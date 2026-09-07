/**
 * The graph runtime: one atomic snapshot, produced by walking the declared
 * topological order.
 *
 * Created **per mount**, never as a module singleton. A singleton would
 * survive StrictMode's unmount/remount cycle, so the second mount would
 * inherit epoch counters, breaker state and in-flight aborts from the first;
 * under Vitest the module registry is per file, so state would also bleed
 * between `it()` blocks and make tests order-dependent.
 */
import { createResource } from "../../../core/dag/resource";
import type { Resource } from "../../../core/dag/resource";
import { rankVenues } from "../lib/venue-ranking";
import type { PlaceResult, RankedVenue } from "../lib/venue-ranking";
import type { LatLng } from "../lib/geo-math";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import { TOPO_ORDER } from "./edges";
import {
  buildSlotVector,
  deriveLiveness,
  deriveMidpoint,
  deriveDestination,
  derivePhase,
} from "./nodes";
import {
  createVenuePolicy,
  createRoutePolicy,
  createPresencePolicy,
} from "./policies";
import type { PresenceInput, RouteInput, VenueInput } from "./policies";
import type { GraphPorts } from "./ports";
import type {
  GraphSources,
  LivenessResult,
  RouteInfo,
  SessionPhase,
  SlotVector,
  TravelProfile,
} from "./types";

const TOP_VENUES = 5;

const EMPTY_VENUES: readonly RankedVenue[] = Object.freeze([]);
const EMPTY_ROUTES: readonly (RouteInfo | null)[] = Object.freeze(
  new Array<RouteInfo | null>(MAX_PARTICIPANTS).fill(null),
);

export const DEFAULT_SOURCES: GraphSources = {
  ownSlot: null,
  ownPosition: null,
  ownAccuracy: null,
  participants: [],
  selectedVenueId: null,
  travelProfile: "driving",
  sessionCode: null,
  ownUid: null,
  ownName: "",
  sessionStatus: "idle",
};

const NO_LIVENESS: LivenessResult = Object.freeze({
  stale: Object.freeze(new Array<boolean>(MAX_PARTICIPANTS).fill(false)),
  nextFlipAtMs: null,
});

export interface GraphSnapshot {
  readonly slots: SlotVector;
  readonly midpoint: LatLng | null;
  readonly venues: readonly RankedVenue[];
  readonly venuesLoading: boolean;
  readonly selectedVenue: RankedVenue | null;
  readonly destination: LatLng | null;
  readonly routes: readonly (RouteInfo | null)[];
  /** Routes are being served from cache after a failure. */
  readonly routesDegraded: boolean;
  readonly travelProfile: TravelProfile;
  /** Derived, never stored — see `derivePhase`. */
  readonly phase: SessionPhase;
  /** Own location is not reaching RTDB; peers will start seeing us as stale. */
  readonly presenceFailed: boolean;
}

export interface GraphRuntime {
  readonly getSnapshot: () => GraphSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Merge a patch of source values. Takes an object rather than per-key
   * setters so a handler changing two sources produces one tick and one
   * render, not two.
   */
  readonly setSources: (patch: Partial<GraphSources>) => void;
  readonly dispose: () => void;
  /** True once disposed; the React adapter uses this to detect StrictMode's
   * simulated unmount and stand up a replacement. */
  readonly isDisposed: () => boolean;
}

function sameLatLng(a: LatLng | null, b: LatLng | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.lat === b.lat && a.lng === b.lng;
}

/**
 * Element-wise comparison so an unchanged roster reuses the previous object.
 * RTDB hands us a fresh array on every snapshot, so without this every
 * heartbeat would allocate a new SlotVector and invalidate the whole graph.
 */
function sameSlots(a: SlotVector, b: SlotVector): boolean {
  if (a.ownSlot !== b.ownSlot) return false;
  if (a.occupied.length !== b.occupied.length) return false;
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (!sameLatLng(a.positions[i] ?? null, b.positions[i] ?? null)) {
      return false;
    }
    if (a.accuracy[i] !== b.accuracy[i]) return false;
    if (a.stale[i] !== b.stale[i]) return false;
    if (a.names[i] !== b.names[i]) return false;
  }
  return true;
}

export function createRuntime(
  ports: GraphPorts,
  initial: Partial<GraphSources> = {},
): GraphRuntime {
  let sources: GraphSources = { ...DEFAULT_SOURCES, ...initial };
  const listeners = new Set<() => void>();

  const venues: Resource<VenueInput, PlaceResult[]> = createResource(
    createVenuePolicy(ports),
    ports,
  );
  const routes: Resource<RouteInput, (RouteInfo | null)[]> = createResource(
    createRoutePolicy(ports),
    ports,
  );
  const presence: Resource<PresenceInput, null> = createResource(
    createPresencePolicy(ports),
    ports,
  );

  // Memo cells. Each holds the previous output so an unchanged computation
  // returns the identical reference and the snapshot stays stable — which
  // useSyncExternalStore requires of getSnapshot.
  let liveness: LivenessResult = NO_LIVENESS;
  let slots: SlotVector = buildSlotVector(sources, liveness);
  let midpoint: LatLng | null = null;
  let phase: SessionPhase = "idle";
  // One timer for the whole liveness concern, armed at the next instant some
  // participant's staleness flips. Replaces a 10s setInterval that ran for the
  // life of the session whether or not anything was about to change.
  let livenessTimer: ReturnType<GraphPorts["schedule"]> | null = null;
  let livenessArmedFor: number | null = null;
  let ranked: readonly RankedVenue[] = EMPTY_VENUES;
  let rankedFromRaw: PlaceResult[] | null = null;
  let rankedAtCenter: LatLng | null = null;

  let snapshot: GraphSnapshot = {
    slots,
    midpoint: null,
    venues: EMPTY_VENUES,
    venuesLoading: false,
    selectedVenue: null,
    destination: null,
    routes: EMPTY_ROUTES,
    routesDegraded: false,
    travelProfile: sources.travelProfile,
    phase: "idle",
    presenceFailed: false,
  };

  let disposed = false;
  let ticking = false;
  let tickAgain = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Arm a single wake for the next staleness transition.
   *
   * Re-armed only when the target instant actually changes, so a heartbeat
   * that does not move the earliest flip costs nothing. Nothing is armed when
   * every participant is already stale — there is no further transition to
   * wait for, and the next real event will recompute anyway.
   */
  function armLivenessWake(atMs: number | null): void {
    if (atMs === livenessArmedFor) return;
    if (livenessTimer !== null) {
      ports.cancel(livenessTimer);
      livenessTimer = null;
    }
    livenessArmedFor = atMs;
    if (atMs === null) return;
    // Defence in depth against the loop above: a target that is not strictly
    // in the future would schedule at a zero delay and re-derive the same
    // target. `deriveLiveness` cannot produce one, and this makes it so that a
    // future change to that predicate degrades to a missed wake — recovered on
    // the next real event — rather than to a spinning main thread.
    if (atMs <= ports.now()) return;
    livenessTimer = ports.schedule(
      () => {
        livenessTimer = null;
        livenessArmedFor = null;
        tick();
      },
      Math.max(0, atMs - ports.now()),
    );
  }

  function compute(): void {
    let nextDestination: LatLng | null = null;
    let nextSelected: RankedVenue | null = null;

    // Walk the declared order so the edge map governs execution rather than
    // merely documenting it. noFallthroughCasesInSwitch keeps this exhaustive.
    for (const node of TOPO_ORDER) {
      switch (node) {
        case "liveness": {
          liveness = deriveLiveness(sources.participants, ports.now());
          armLivenessWake(liveness.nextFlipAtMs);
          break;
        }
        case "slots": {
          const next = buildSlotVector(sources, liveness);
          if (!sameSlots(next, slots)) slots = next;
          break;
        }
        case "presence": {
          const code = sources.sessionCode;
          const uid = sources.ownUid;
          const position = sources.ownPosition;
          // `null` until every part exists. The old code had an explicit
          // "flush once the code arrives" effect for exactly this gap, because
          // a stationary joiner's single GPS fix could land before the async
          // join resolved and then never be written at all.
          if (code !== null && uid !== null && position !== null) {
            presence.request({
              code,
              uid,
              position,
              accuracy: sources.ownAccuracy ?? 0,
              name: sources.ownName,
            });
          } else {
            presence.request(null);
          }
          break;
        }
        case "phase": {
          phase = derivePhase(sources.sessionStatus, slots, liveness);
          break;
        }
        case "midpoint": {
          const next = deriveMidpoint(slots);
          if (!sameLatLng(next, midpoint)) midpoint = next;
          break;
        }
        case "venues": {
          if (ports.placesEnabled && midpoint !== null) {
            venues.request({ center: midpoint });
          } else {
            venues.request(null);
          }
          const raw = venues.getState().value;
          // Re-rank per tick against the live midpoint: scores are relative
          // to the max distance within the returned set, so a ranking
          // computed for an older centre would be subtly wrong.
          if (raw === null || midpoint === null) {
            ranked = EMPTY_VENUES;
            rankedFromRaw = null;
            rankedAtCenter = null;
          } else if (
            raw !== rankedFromRaw ||
            !sameLatLng(midpoint, rankedAtCenter)
          ) {
            ranked = rankVenues(raw, midpoint, TOP_VENUES);
            rankedFromRaw = raw;
            rankedAtCenter = midpoint;
          }
          break;
        }
        case "destination": {
          const result = deriveDestination(
            ranked,
            sources.selectedVenueId,
            midpoint,
          );
          nextDestination = result.destination;
          nextSelected = result.selectedVenue;
          break;
        }
        case "routes": {
          if (nextDestination !== null && slots.occupied.length > 0) {
            routes.request({
              slots: slots.positions,
              dest: nextDestination,
              profile: sources.travelProfile,
            });
          } else {
            routes.request(null);
          }
          break;
        }
        case "frame": {
          const venueState = venues.getState();
          const routeState = routes.getState();
          const presenceState = presence.getState();
          const next: GraphSnapshot = {
            slots,
            midpoint,
            venues: ranked,
            venuesLoading: venueState.status === "pending",
            selectedVenue: nextSelected,
            destination: sameLatLng(nextDestination, snapshot.destination)
              ? snapshot.destination
              : nextDestination,
            routes: routeState.value ?? EMPTY_ROUTES,
            routesDegraded: routeState.status === "degraded",
            travelProfile: sources.travelProfile,
            phase,
            presenceFailed: presenceState.status === "failed",
          };
          if (
            next.slots !== snapshot.slots ||
            next.midpoint !== snapshot.midpoint ||
            next.venues !== snapshot.venues ||
            next.venuesLoading !== snapshot.venuesLoading ||
            next.selectedVenue !== snapshot.selectedVenue ||
            next.destination !== snapshot.destination ||
            next.routes !== snapshot.routes ||
            next.routesDegraded !== snapshot.routesDegraded ||
            next.travelProfile !== snapshot.travelProfile ||
            next.phase !== snapshot.phase ||
            next.presenceFailed !== snapshot.presenceFailed
          ) {
            snapshot = next;
            notify();
          }
          break;
        }
      }
    }
  }

  function tick(): void {
    if (disposed) return;
    if (ticking) {
      tickAgain = true;
      return;
    }
    ticking = true;
    try {
      do {
        tickAgain = false;
        compute();
      } while (tickAgain);
    } finally {
      ticking = false;
    }
  }

  venues.subscribe(tick);
  routes.subscribe(tick);
  presence.subscribe(tick);

  function setSources(patch: Partial<GraphSources>): void {
    if (disposed) return;
    let changed = false;
    for (const key of Object.keys(patch) as (keyof GraphSources)[]) {
      if (!Object.is(sources[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    sources = { ...sources, ...patch };
    tick();
  }

  // Seed derived state from the initial sources.
  tick();

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSources,
    dispose: () => {
      disposed = true;
      if (livenessTimer !== null) ports.cancel(livenessTimer);
      livenessTimer = null;
      livenessArmedFor = null;
      venues.dispose();
      routes.dispose();
      presence.dispose();
      listeners.clear();
    },
    isDisposed: () => disposed,
  };
}

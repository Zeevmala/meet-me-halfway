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
import type { ParticipantIndex } from "../lib/participant-config";
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
  PRESENCE_HEARTBEAT_MS,
  routesAnswer,
} from "./policies";
import type { PresenceInput, RouteInput, VenueInput } from "./policies";
import type { GraphPorts } from "./ports";
import type {
  GraphSources,
  LivenessResult,
  RouteInfo,
  RouteSet,
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
  serverTimeOffsetMs: 0,
};

const NO_FLAGS: readonly boolean[] = Object.freeze(
  new Array<boolean>(MAX_PARTICIPANTS).fill(false),
);

const NO_LIVENESS: LivenessResult = Object.freeze({
  stale: NO_FLAGS,
  departed: NO_FLAGS,
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
  if (a.counted.length !== b.counted.length) return false;
  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (!sameLatLng(a.positions[i] ?? null, b.positions[i] ?? null)) {
      return false;
    }
    if (a.accuracy[i] !== b.accuracy[i]) return false;
    if (a.stale[i] !== b.stale[i]) return false;
    if (a.departed[i] !== b.departed[i]) return false;
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
  const routes: Resource<RouteInput, RouteSet> = createResource(
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
  // Offers own position again while it is being published, so a participant
  // standing still keeps writing — see PRESENCE_HEARTBEAT_MS.
  let heartbeatTimer: ReturnType<GraphPorts["schedule"]> | null = null;
  // Positions the routes are computed from, and the routes published from
  // them — both memoised so an unchanged roster keeps its references.
  let countedFor: SlotVector | null = null;
  let countedPositions: readonly (LatLng | null)[] = EMPTY_ROUTES.map(
    () => null,
  );
  let publishedRoutes: readonly (RouteInfo | null)[] = EMPTY_ROUTES;
  let publishedFrom: RouteSet | null = null;
  let publishedMask = "";
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
   * every participant has departed — there is no further transition to wait
   * for, and the next real event will recompute anyway.
   *
   * The flip is in server time; the timer runs on this device's clock, so it
   * is keyed by the device instant. Keyed by the server instant, a re-measured
   * offset left the wake on the old one: the flip had not moved, so nothing
   * re-armed.
   */
  function armLivenessWake(atServerMs: number | null): void {
    const atMs =
      atServerMs === null ? null : atServerMs - sources.serverTimeOffsetMs;
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

  /** Keep one heartbeat wake armed while own position is being published. */
  function armHeartbeat(publishing: boolean): void {
    if (!publishing) {
      if (heartbeatTimer !== null) ports.cancel(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }
    if (heartbeatTimer !== null) return;
    heartbeatTimer = ports.schedule(() => {
      heartbeatTimer = null;
      tick();
    }, PRESENCE_HEARTBEAT_MS);
  }

  /** Slot positions with everyone not counted — vacant or departed — nulled. */
  function positionsCounted(of: SlotVector): readonly (LatLng | null)[] {
    if (of !== countedFor) {
      countedFor = of;
      countedPositions = of.positions.map((position, slot) =>
        of.counted.includes(slot as ParticipantIndex) ? position : null,
      );
    }
    return countedPositions;
  }

  /**
   * The routes to show: only a set that still answers the current
   * destination and profile, and only for participants still counted.
   *
   * The resource keeps its last value through any change of input, so this
   * used to publish whatever it last fetched: routes for a venue no longer
   * picked, and for participants who had left — drawn and listed until the
   * next fetch replaced them, which never came once the destination itself
   * was gone.
   */
  function routesToPublish(
    set: RouteSet | null,
    dest: LatLng | null,
    of: SlotVector,
  ): readonly (RouteInfo | null)[] {
    if (set === null || dest === null) return EMPTY_ROUTES;
    if (!routesAnswer(set, dest, sources.travelProfile)) return EMPTY_ROUTES;
    const mask = of.counted.join(",");
    if (set !== publishedFrom || mask !== publishedMask) {
      publishedFrom = set;
      publishedMask = mask;
      publishedRoutes = set.bySlot.map((route, slot) =>
        of.counted.includes(slot as ParticipantIndex) ? route : null,
      );
    }
    return publishedRoutes;
  }

  function compute(): void {
    let nextDestination: LatLng | null = null;
    let nextSelected: RankedVenue | null = null;

    // Walk the declared order so the edge map governs execution rather than
    // merely documenting it. noFallthroughCasesInSwitch keeps this exhaustive.
    for (const node of TOPO_ORDER) {
      switch (node) {
        case "liveness": {
          // Server time: peers' `lastSeen` is stamped by the server.
          const serverNowMs = ports.now() + sources.serverTimeOffsetMs;
          liveness = deriveLiveness(sources.participants, serverNowMs);
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
          const slot = sources.ownSlot;
          // `null` until every part exists — the slot included, since it is
          // the RTDB key this write lands on and the server will refuse a
          // write to a slot we do not hold. The old code had an explicit
          // "flush once the code arrives" effect for exactly this gap, because
          // a stationary joiner's single GPS fix could land before the async
          // join resolved and then never be written at all.
          if (
            code !== null &&
            uid !== null &&
            position !== null &&
            slot !== null
          ) {
            presence.request({
              code,
              slot,
              uid,
              position,
              accuracy: sources.ownAccuracy ?? 0,
              name: sources.ownName,
            });
            armHeartbeat(true);
          } else {
            presence.request(null);
            armHeartbeat(false);
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
          if (nextDestination !== null && slots.counted.length > 0) {
            routes.request({
              slots: positionsCounted(slots),
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
            routes: routesToPublish(routeState.value, nextDestination, slots),
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
      if (heartbeatTimer !== null) ports.cancel(heartbeatTimer);
      heartbeatTimer = null;
      venues.dispose();
      routes.dispose();
      presence.dispose();
      listeners.clear();
    },
    isDisposed: () => disposed,
  };
}

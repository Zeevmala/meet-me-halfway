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
import type { Resource, ResourceState } from "../../../core/dag/resource";
import { rankWithPinned } from "../lib/venue-ranking";
import type { PlaceResult, RankedVenue } from "../lib/venue-ranking";
import type { LatLng } from "../lib/geo-math";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import type { ParticipantIndex } from "../lib/participant-config";
import { TOPO_ORDER } from "./edges";
import {
  buildSlotVector,
  deriveExpiry,
  deriveLiveness,
  deriveMidpoint,
  deriveDestination,
  derivePhase,
  latestPin,
  sessionCode,
  sessionSlot,
} from "./nodes";
import {
  createVenuePolicy,
  createRoutePolicy,
  createPresencePolicy,
  createMeetPolicy,
  PRESENCE_HEARTBEAT_MS,
  routesAnswer,
} from "./policies";
import type {
  MeetInput,
  PresenceInput,
  RouteInput,
  VenueInput,
} from "./policies";
import type { GraphPorts } from "./ports";
import type {
  ExpiryResult,
  GraphSources,
  LivenessResult,
  PinEvent,
  RouteInfo,
  RouteSet,
  SessionLifecycle,
  SessionPhase,
  SlotVector,
  TravelProfile,
  VenueStatus,
} from "./types";

const TOP_VENUES = 5;

/**
 * What the venue list can truthfully say, from the search resource's state.
 * A value — fresh, being refreshed, or degraded to the last good one — is an
 * answer; a failure with nothing to show is a failure; anything else while a
 * search is wanted is still searching, including the debounce before the
 * first request, which the resource reports as `idle`.
 */
function venueStatusOf(
  state: ResourceState<PlaceResult[]>,
  wanted: boolean,
): VenueStatus {
  if (!wanted) return "idle";
  if (state.value !== null) return "ready";
  return state.status === "failed" ? "failed" : "searching";
}

const EMPTY_VENUES: readonly RankedVenue[] = Object.freeze([]);
const EMPTY_ROUTES: readonly (RouteInfo | null)[] = Object.freeze(
  new Array<RouteInfo | null>(MAX_PARTICIPANTS).fill(null),
);

const IDLE_SESSION: SessionLifecycle = Object.freeze({ kind: "idle" });

export const DEFAULT_SOURCES: GraphSources = {
  session: IDLE_SESSION,
  ownPosition: null,
  ownAccuracy: null,
  participants: [],
  selectedPlace: null,
  ownPin: null,
  peerPins: [],
  travelProfile: "driving",
  ownUid: null,
  ownName: "",
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

const NOT_EXPIRING: ExpiryResult = Object.freeze({
  expired: false,
  flipAtMs: null,
});

export interface GraphSnapshot {
  readonly slots: SlotVector;
  readonly midpoint: LatLng | null;
  /** The top five, plus the picked venue wherever it now ranks. */
  readonly venues: readonly RankedVenue[];
  readonly venueStatus: VenueStatus;
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
  /**
   * The meeting point somebody set, or `null` while there is none and the
   * destination is the live midpoint (or this device's pick).
   */
  readonly pin: PinEvent | null;
  /**
   * By slot: whether that slot has been on the map at some point while this
   * page was open, own slot excluded. A claim is never released, so this is
   * how a device that shared and then left is told from one that joined and
   * never shared.
   */
  readonly seenSharing: readonly boolean[];
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
  /**
   * Set the meeting point for everyone, as this device's slot, now. Later
   * than any pin this device knows, so it is the one that stands. Ignored
   * while there is no session slot to set it as.
   */
  readonly setMeetingPoint: (position: LatLng, name: string | null) => void;
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
  const meet: Resource<MeetInput, null> = createResource(
    createMeetPolicy(ports),
    ports,
  );

  // Memo cells. Each holds the previous output so an unchanged computation
  // returns the identical reference and the snapshot stays stable — which
  // useSyncExternalStore requires of getSnapshot.
  let liveness: LivenessResult = NO_LIVENESS;
  let expiry: ExpiryResult = NOT_EXPIRING;
  let slots: SlotVector = buildSlotVector(sources, liveness);
  let midpoint: LatLng | null = null;
  let phase: SessionPhase = "idle";
  // One timer per clock predicate, armed at the next instant it flips: for
  // liveness, the next participant to turn stale or depart; for expiry, the
  // end of the session's 24 hours. Liveness replaces a 10s setInterval that
  // ran for the life of the session whether or not anything was about to
  // change.
  const livenessWake = createClockWake();
  const expiryWake = createClockWake();
  // Offers own position again while it is being published, so a participant
  // standing still keeps writing — see PRESENCE_HEARTBEAT_MS.
  let heartbeatTimer: ReturnType<GraphPorts["schedule"]> | null = null;
  // Where the presence node last offered a write, until it removes it. It is
  // the one place that both writes own position and deletes it: the deletion
  // used to be the session hook's, and a write still retrying in the graph
  // put back a position the hook had just removed.
  let published: { code: string; slot: ParticipantIndex } | null = null;
  // The meeting point: the latest pin this device has seen in this session,
  // and where it last published its own copy of it.
  let pin: PinEvent | null = null;
  let pinCode: string | null = null;
  // The other slots seen on the map since the session went live: a fold,
  // like the pin, since those who left are no longer there to see.
  let seenSharing: readonly boolean[] = NO_FLAGS;
  let seenCode: string | null = null;
  let meetPublished: { code: string; slot: ParticipantIndex } | null = null;
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
  let rankedWithPick: PlaceResult | null = null;
  let rankedAtCenter: LatLng | null = null;

  let snapshot: GraphSnapshot = {
    slots,
    midpoint: null,
    venues: EMPTY_VENUES,
    venueStatus: "idle",
    selectedVenue: null,
    destination: null,
    routes: EMPTY_ROUTES,
    routesDegraded: false,
    travelProfile: sources.travelProfile,
    phase: "idle",
    presenceFailed: false,
    pin: null,
    seenSharing: NO_FLAGS,
  };

  let disposed = false;
  let ticking = false;
  let tickAgain = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /**
   * A single wake for the next transition of one clock predicate.
   *
   * Re-armed only when the target instant actually changes, so a heartbeat
   * that does not move the earliest flip costs nothing. Nothing is armed for
   * `null` — no further transition to wait for (every participant departed,
   * no session to expire) — and the next real event will recompute anyway.
   *
   * The flip is in server time; the timer runs on this device's clock, so it
   * is keyed by the device instant. Keyed by the server instant, a re-measured
   * offset left the wake on the old one: the flip had not moved, so nothing
   * re-armed.
   */
  function createClockWake() {
    let timer: ReturnType<GraphPorts["schedule"]> | null = null;
    let armedFor: number | null = null;

    function cancel(): void {
      if (timer !== null) ports.cancel(timer);
      timer = null;
      armedFor = null;
    }

    function arm(atServerMs: number | null): void {
      const atMs =
        atServerMs === null ? null : atServerMs - sources.serverTimeOffsetMs;
      if (atMs === armedFor) return;
      cancel();
      armedFor = atMs;
      if (atMs === null) return;
      // Defence in depth against the loop above: a target that is not
      // strictly in the future would schedule at a zero delay and re-derive
      // the same target. The derivations cannot produce one, and this makes
      // it so that a future change to a predicate degrades to a missed wake —
      // recovered on the next real event — rather than to a spinning main
      // thread.
      if (atMs <= ports.now()) return;
      timer = ports.schedule(
        () => {
          timer = null;
          armedFor = null;
          tick();
        },
        Math.max(0, atMs - ports.now()),
      );
    }

    return { arm, cancel };
  }

  /**
   * Delete what the presence node published, once it no longer publishes.
   *
   * Runs after the resource has been told `null`, which abandons a write
   * still in flight; one already sent reaches the server first, since both go
   * over the same socket in order.
   */
  function withdrawPublished(): void {
    if (published === null) return;
    ports.removePresence(published.code, published.slot);
    published = null;
  }

  /** Delete this device's copy of the meeting point, once it is not publishing one. */
  function withdrawMeet(): void {
    if (meetPublished === null) return;
    ports.removeMeet(meetPublished.code, meetPublished.slot);
    meetPublished = null;
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
    let publishing = false;

    // Walk the declared order so the edge map governs execution rather than
    // merely documenting it. noFallthroughCasesInSwitch keeps this exhaustive.
    for (const node of TOPO_ORDER) {
      switch (node) {
        case "liveness": {
          // Server time: peers' `lastSeen` is stamped by the server.
          const serverNowMs = ports.now() + sources.serverTimeOffsetMs;
          liveness = deriveLiveness(sources.participants, serverNowMs);
          livenessWake.arm(liveness.nextFlipAtMs);
          break;
        }
        case "expiry": {
          // Server time again: `created` is stamped by the server.
          const serverNowMs = ports.now() + sources.serverTimeOffsetMs;
          expiry = deriveExpiry(sources.session, serverNowMs);
          expiryWake.arm(expiry.flipAtMs);
          break;
        }
        case "slots": {
          const next = buildSlotVector(sources, liveness);
          if (!sameSlots(next, slots)) slots = next;
          const code = sessionCode(sources.session);
          if (code !== seenCode) {
            seenCode = code;
            seenSharing = NO_FLAGS;
          }
          let seen: boolean[] | null = null;
          for (const slot of slots.occupied) {
            if (slot === slots.ownSlot || seenSharing[slot] === true) continue;
            seen ??= [...seenSharing];
            seen[slot] = true;
          }
          if (seen !== null) seenSharing = seen;
          break;
        }
        case "presence": {
          const session = sources.session;
          const uid = sources.ownUid;
          const position = sources.ownPosition;
          // Published only into a live session that has not expired, and
          // only with a position: the slot is the RTDB key this write lands
          // on, and the server refuses a write to an expired session or to a
          // slot we do not hold. The old code had an explicit "flush once the
          // code arrives" effect for the gap before the slot, because a
          // stationary joiner's single GPS fix could land before the async
          // join resolved and then never be written at all.
          if (
            session.kind === "live" &&
            !expiry.expired &&
            uid !== null &&
            position !== null
          ) {
            const { code, slot } = session;
            if (
              published !== null &&
              (published.code !== code || published.slot !== slot)
            ) {
              withdrawPublished();
            }
            presence.request({
              code,
              slot,
              uid,
              position,
              accuracy: sources.ownAccuracy ?? 0,
              name: sources.ownName,
            });
            if (published === null) published = { code, slot };
            armHeartbeat(true);
            publishing = true;
          } else {
            // However it stopped — location off, the session lost, expired
            // or closed — what was published comes down here.
            presence.request(null);
            armHeartbeat(false);
            withdrawPublished();
          }
          break;
        }
        case "pin": {
          // One session's pins say nothing about another's.
          const code = sessionCode(sources.session);
          if (code !== null && code !== pinCode) {
            pinCode = code;
            pin = null;
          }
          pin = latestPin(pin, [sources.ownPin, ...sources.peerPins]);
          break;
        }
        case "meet": {
          // Published alongside own position, and taken down with it: it is
          // a copy of something the others already have, but whoever stops
          // sharing stops sharing everything.
          const session = sources.session;
          if (publishing && pin !== null && session.kind === "live") {
            const { code, slot } = session;
            if (
              meetPublished !== null &&
              (meetPublished.code !== code || meetPublished.slot !== slot)
            ) {
              withdrawMeet();
            }
            meet.request({ code, slot, pin });
            if (meetPublished === null) meetPublished = { code, slot };
          } else {
            meet.request(null);
            withdrawMeet();
          }
          break;
        }
        case "phase": {
          phase = derivePhase(sources.session, expiry, slots, liveness);
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
          const picked = sources.selectedPlace;
          // Re-rank per tick against the live midpoint: scores are relative
          // to the max distance within the returned set, so a ranking
          // computed for an older centre would be subtly wrong. The pick is
          // pinned into the result (`rankWithPinned`), so it stays listed —
          // and the destination — however the ranking moves.
          if (
            !ports.placesEnabled ||
            midpoint === null ||
            (raw === null && picked === null)
          ) {
            ranked = EMPTY_VENUES;
            rankedFromRaw = null;
            rankedWithPick = null;
            rankedAtCenter = null;
          } else if (
            raw !== rankedFromRaw ||
            picked !== rankedWithPick ||
            !sameLatLng(midpoint, rankedAtCenter)
          ) {
            ranked = rankWithPinned(raw ?? [], midpoint, TOP_VENUES, picked);
            rankedFromRaw = raw;
            rankedWithPick = picked;
            rankedAtCenter = midpoint;
          }
          break;
        }
        case "destination": {
          const result = deriveDestination(
            ranked,
            sources.selectedPlace,
            midpoint,
            pin,
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
            venueStatus: venueStatusOf(
              venueState,
              ports.placesEnabled && midpoint !== null,
            ),
            selectedVenue: nextSelected,
            destination: sameLatLng(nextDestination, snapshot.destination)
              ? snapshot.destination
              : nextDestination,
            routes: routesToPublish(routeState.value, nextDestination, slots),
            routesDegraded: routeState.status === "degraded",
            travelProfile: sources.travelProfile,
            phase,
            presenceFailed: presenceState.status === "failed",
            pin,
            seenSharing,
          };
          if (
            next.slots !== snapshot.slots ||
            next.midpoint !== snapshot.midpoint ||
            next.venues !== snapshot.venues ||
            next.venueStatus !== snapshot.venueStatus ||
            next.selectedVenue !== snapshot.selectedVenue ||
            next.destination !== snapshot.destination ||
            next.routes !== snapshot.routes ||
            next.routesDegraded !== snapshot.routesDegraded ||
            next.travelProfile !== snapshot.travelProfile ||
            next.phase !== snapshot.phase ||
            next.presenceFailed !== snapshot.presenceFailed ||
            next.pin !== snapshot.pin ||
            next.seenSharing !== snapshot.seenSharing
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
  meet.subscribe(tick);

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

  function setMeetingPoint(position: LatLng, name: string | null): void {
    if (disposed) return;
    const slot = sessionSlot(sources.session);
    if (slot === null) return;
    const serverNowMs = Math.round(ports.now() + sources.serverTimeOffsetMs);
    // Later than every pin this device knows, whatever its clock says. A tap
    // is the newest decision there is, and on a clock running a little
    // behind the device that set the current pin, "now" would lose to it.
    const at = Math.max(serverNowMs, pin === null ? 0 : pin.at + 1);
    // An empty name is no name: the rules refuse one, and "Set by " says
    // nothing.
    const byName = sources.ownName.trim() === "" ? null : sources.ownName;
    setSources({ ownPin: { at, by: slot, byName, position, name } });
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
    setMeetingPoint,
    dispose: () => {
      disposed = true;
      livenessWake.cancel();
      expiryWake.cancel();
      if (heartbeatTimer !== null) ports.cancel(heartbeatTimer);
      heartbeatTimer = null;
      venues.dispose();
      routes.dispose();
      // Torn down with the page's tree: stop writing first — disposing aborts
      // a write in flight — then take down what was published.
      presence.dispose();
      withdrawPublished();
      meet.dispose();
      withdrawMeet();
      listeners.clear();
    },
    isDisposed: () => disposed,
  };
}

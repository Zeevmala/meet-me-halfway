/**
 * The two effectful nodes, expressed as resource policies.
 *
 * Both were previously bespoke hook internals with incompatible semantics
 * (venues: 5s stability delay + 100m cache; routes: 3s debounce + 200m
 * threshold + a backoff that doubled the debounce). They differ only in
 * constants and arity once `admits` and `identity` are kept apart.
 */
import { haversineDistance } from "../lib/geo-math";
import type { LatLng } from "../lib/geo-math";
import type { PlaceResult } from "../lib/venue-ranking";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import type { ResourceError } from "../../../core/dag/errors";
import type { ResourcePolicy } from "../../../core/dag/resource";
import type { ParticipantIndex } from "../lib/participant-config";
import type { GraphPorts } from "./ports";
import type { OwnRoute, PinEvent, RouteInfo, TravelProfile } from "./types";
import { samePin } from "./nodes";
import { encodeRouteLine } from "../lib/polyline";

const SEARCH_RADIUS_M = 1_000;
const VENUE_ADMIT_M = 100;
const ROUTE_ADMIT_M = 200;

/** Refresh venues at least this often even while standing still. */
const VENUE_TTL_MS = 5 * 60_000;

/**
 * How long a route stands for the same start, destination and profile.
 *
 * It was a minute — "routes go stale faster: traffic moves" — and every
 * minute every device asked again for every participant's route. But the
 * profiles asked for, `driving` and `walking`, are not traffic-aware: the
 * same question gets the same answer. Movement is what changes a route, and
 * movement asks again by itself. This only bounds how old an answer gets.
 */
export const ROUTE_REFRESH_MS = 5 * 60_000;

const METERS_PER_DEG_LAT = 111_320;

/**
 * Quantise a point to a grid cell.
 *
 * Used **only** for `identity`, never for admission: a collision here merely
 * collapses a duplicate in-flight request, which is harmless. Longitude is
 * scaled by latitude, without which a fixed degree rounding would mean 94m at
 * Tel Aviv and 56m at 60°N — the behaviour would quietly change for the first
 * user outside the country.
 */
function cellKey(point: LatLng, cellMeters: number): string {
  const latCell = Math.round((point.lat * METERS_PER_DEG_LAT) / cellMeters);
  const metersPerDegLng = Math.max(
    METERS_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180),
    1,
  );
  const lngCell = Math.round((point.lng * metersPerDegLng) / cellMeters);
  return `${latCell}:${lngCell}`;
}

export interface VenueInput {
  readonly center: LatLng;
}

/**
 * Venues cache the **raw** PlaceResult[], not the ranked list.
 *
 * `computeVenueScore` divides its proximity term by the maximum distance over
 * the returned set, so the same places ranked against a different centre
 * produce different scores and a different order. Caching ranked output would
 * therefore serve an ordering computed for a centre the user has since moved
 * away from. Ranking is re-run per tick against the live midpoint instead —
 * free at 20 elements.
 */
export function createVenuePolicy(
  ports: GraphPorts,
): ResourcePolicy<VenueInput, PlaceResult[]> {
  return {
    id: "venues",
    debounceMs: 5_000,
    maxWaitMs: 15_000,
    timeoutMs: 8_000,
    staleAfterMs: VENUE_TTL_MS,
    retryAttempts: 2,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 4,
      baseOpenMs: 30_000,
      maxOpenMs: 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      haversineDistance(previous.center, next.center) >= VENUE_ADMIT_M ||
      nowMs - previousAtMs >= VENUE_TTL_MS,
    identity: (input) => `v:${cellKey(input.center, VENUE_ADMIT_M)}`,
    run: (input, signal) =>
      ports.searchVenues(input.center, SEARCH_RADIUS_M, signal),
  };
}

export interface PresenceInput {
  readonly code: string;
  /** The claimed slot — the RTDB key this write lands on. */
  readonly slot: ParticipantIndex;
  /** Travels in the payload so peers can tell themselves apart. */
  readonly uid: string;
  readonly position: LatLng;
  readonly accuracy: number;
  readonly name: string;
}

/** One RTDB write per this window, matching the old WRITE_THROTTLE_MS. */
const PRESENCE_WRITE_MS = 3_000;

/**
 * How often the runtime offers a stationary participant's position again.
 *
 * Admission alone is not a heartbeat: `admits` only runs when something asks.
 * With GPS quiet and nobody moving, the only askers were peers' liveness wakes,
 * which fire at the instant a peer has already turned stale — and a participant
 * alone in the session, waiting, was never asked again. Peers mark anyone
 * silent for `STALE_THRESHOLD_MS` (30s) as stale; a third of that leaves room
 * for two missed beats.
 */
export const PRESENCE_HEARTBEAT_MS = 10_000;
/**
 * Displacement worth an early write. Deliberately below typical GPS noise:
 * the TTL clause below guarantees a heartbeat regardless, so this exists only
 * to make real movement visible sooner, and `admits` compares against the last
 * *accepted* write — its baseline advances, so noise cannot ratchet it.
 */
const PRESENCE_ADMIT_M = 10;

/**
 * Own location, published to RTDB.
 *
 * This is a write, not a read, and it is still a `createResource`: everything
 * the combinator provides — a debounce with a starvation ceiling, admission on
 * displacement, in-flight de-duplication, abort, timeout, retry and a circuit
 * breaker — is exactly what the hand-rolled version was approximating with a
 * pair of refs, a `setTimeout` and a separate `withRetry` that had no
 * cancellation and no breaker.
 *
 * `staleAfterMs: 0` because a write has no value to serve: there is nothing to
 * degrade *to*, so a failure is reported as failed and the UI can say so.
 *
 * The "flush once the session code arrives" effect that used to sit in
 * `useLiveSession` is gone structurally rather than by being reimplemented:
 * the input is simply `null` until code, uid and position all exist, and the
 * resource fires the moment it is not.
 */
export function createPresencePolicy(
  ports: GraphPorts,
): ResourcePolicy<PresenceInput, null> {
  return {
    id: "presence",
    debounceMs: PRESENCE_WRITE_MS,
    // Ceiling equal to the debounce: position updates arrive at GPS rate, so a
    // purely trailing debounce would be reset before it could ever fire.
    maxWaitMs: PRESENCE_WRITE_MS,
    timeoutMs: 10_000,
    staleAfterMs: 0,
    retryAttempts: 3,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 5,
      baseOpenMs: 30_000,
      maxOpenMs: 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.code !== next.code ||
      previous.slot !== next.slot ||
      previous.uid !== next.uid ||
      previous.name !== next.name ||
      haversineDistance(previous.position, next.position) >= PRESENCE_ADMIT_M ||
      // The heartbeat: peers infer staleness from the age of this write, so it
      // has to keep landing even for someone standing still.
      nowMs - previousAtMs >= PRESENCE_WRITE_MS,
    identity: (input) =>
      `pr:${input.code}:${input.slot}:${input.uid}:${input.name}:` +
      cellKey(input.position, PRESENCE_ADMIT_M),
    run: async (input, signal) => {
      const result = await ports.writePresence(
        input.code,
        input.slot,
        {
          uid: input.uid,
          lat: input.position.lat,
          lng: input.position.lng,
          accuracy: input.accuracy,
          name: input.name,
        },
        signal,
      );
      return result.ok ? ok(null) : err(result.error);
    },
  };
}

export interface MeetInput {
  readonly code: string;
  /** The claimed slot — the RTDB key this copy lands on. */
  readonly slot: ParticipantIndex;
  readonly pin: PinEvent;
}

/**
 * How often an unchanged copy of the meeting point is written again.
 *
 * Nothing else would write it. A pin changes when somebody acts, which is
 * rare, and the server deletes this copy whenever the connection drops — a
 * dropped connection that comes back, with the page still open, leaves the
 * copy gone and nothing new to write. Position has its heartbeat for the
 * same reason; this is the pin's, slower, since nobody judges it by its age.
 */
export const MEET_REFRESH_MS = 30_000;

/**
 * This device's copy of the meeting point.
 *
 * No debounce: a pin is set by a tap, usually the tap on Navigate, and the
 * page is on its way to the background as it lands. A write held back three
 * seconds, as position's is, would wait for a page the phone had already
 * suspended — and the pin would never leave it.
 */
export function createMeetPolicy(
  ports: GraphPorts,
): ResourcePolicy<MeetInput, null> {
  return {
    id: "meet",
    debounceMs: 0,
    maxWaitMs: 0,
    timeoutMs: 10_000,
    staleAfterMs: 0,
    retryAttempts: 3,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 5,
      baseOpenMs: 30_000,
      maxOpenMs: 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.code !== next.code ||
      previous.slot !== next.slot ||
      !samePin(previous.pin, next.pin) ||
      nowMs - previousAtMs >= MEET_REFRESH_MS,
    identity: (input) =>
      `m:${input.code}:${input.slot}:${input.pin.at}:${input.pin.by}:` +
      `${input.pin.position.lat},${input.pin.position.lng}`,
    run: async (input, signal) => {
      const { pin } = input;
      const result = await ports.writeMeet(
        input.code,
        input.slot,
        {
          at: pin.at,
          by: pin.by,
          byName: pin.byName,
          lat: pin.position.lat,
          lng: pin.position.lng,
          name: pin.name,
        },
        signal,
      );
      return result.ok ? ok(null) : err(result.error);
    },
  };
}

export interface RouteInput {
  /** This device's own position. */
  readonly from: LatLng;
  readonly dest: LatLng;
  readonly profile: TravelProfile;
}

/**
 * Whether own route still answers the current destination and profile.
 *
 * Within the same radius that decides when to fetch again: a destination that
 * drifted less than that is the one this route was fetched for, and one that
 * moved further — a venue picked, the midpoint shifted — is not, so its time
 * and distance would describe somewhere else.
 */
export function routeAnswers(
  own: OwnRoute,
  dest: LatLng,
  profile: TravelProfile,
): boolean {
  return (
    own.profile === profile && haversineDistance(own.dest, dest) < ROUTE_ADMIT_M
  );
}

/**
 * How far another device's destination may be from this one's for its trip
 * to be shown here. Each device asks for its route again once its own
 * destination has moved 200 m, and the live midpoint each computes is the
 * same one a moment apart, so a trip published for the same destination can
 * be up to that far from this device's view of it — twice the radius keeps it
 * from flickering out at the edge. A meeting point is one place for everyone,
 * so with one set this is moot.
 */
export const PEER_TRIP_ADMIT_M = 2 * ROUTE_ADMIT_M;

/** Whether another participant's trip goes where this device is going. */
export function tripAnswers(dest: LatLng, tripDest: LatLng): boolean {
  return haversineDistance(dest, tripDest) < PEER_TRIP_ADMIT_M;
}

/**
 * This device's route, and only this device's.
 *
 * Every device used to route every participant: one person walking 200 m
 * cost a request per participant on every device — five people, five devices:
 * twenty-five requests for one person's move, against a limit of 300 a
 * minute that every device of every session shares, and each device sent
 * Mapbox all five positions. Now each asks for its own trip and publishes it
 * (`createTripPolicy`); the others draw it from the database.
 *
 * Asked again once this device or its destination has moved 200 m, or the
 * profile changed, or `ROUTE_REFRESH_MS` has passed.
 */
export function createRoutePolicy(
  ports: GraphPorts,
): ResourcePolicy<RouteInput, OwnRoute> {
  return {
    id: "routes",
    debounceMs: 3_000,
    maxWaitMs: 9_000,
    timeoutMs: 10_000,
    // Served after a failed refresh for as long as an answer stands, and a
    // little past the refresh that failed.
    staleAfterMs: 2 * ROUTE_REFRESH_MS,
    retryAttempts: 2,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 5,
      baseOpenMs: 30_000,
      maxOpenMs: 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.profile !== next.profile ||
      haversineDistance(previous.dest, next.dest) >= ROUTE_ADMIT_M ||
      haversineDistance(previous.from, next.from) >= ROUTE_ADMIT_M ||
      nowMs - previousAtMs >= ROUTE_REFRESH_MS,
    identity: (input) =>
      `r:${input.profile}:${cellKey(input.dest, ROUTE_ADMIT_M)}:` +
      cellKey(input.from, ROUTE_ADMIT_M),
    run: async (input, signal): Promise<Result<OwnRoute, ResourceError>> => {
      const result = await ports.fetchRoute(
        input.from,
        input.dest,
        input.profile,
        signal,
      );
      return result.ok
        ? ok({ dest: input.dest, profile: input.profile, route: result.value })
        : err(result.error);
    },
  };
}

export interface TripInput {
  readonly code: string;
  /** The claimed slot — the RTDB key this trip lands on. */
  readonly slot: ParticipantIndex;
  readonly dest: LatLng;
  readonly profile: TravelProfile;
  readonly route: RouteInfo;
}

/**
 * How often an unchanged trip is written again: for the same reason, and at
 * the same pace, as the meeting point's copy (`MEET_REFRESH_MS`) — the server
 * deletes it whenever the connection drops, and nothing else would put it
 * back.
 */
export const TRIP_REFRESH_MS = MEET_REFRESH_MS;

/**
 * This device's trip, for the others to draw: where it goes, how, how long,
 * and the line, encoded (`lib/polyline.ts`).
 *
 * No debounce: it changes only when own route does, which is already
 * debounced, and the page may be on its way to the background — a route
 * asked for as Navigate is tapped is the one the others want to see.
 */
export function createTripPolicy(
  ports: GraphPorts,
): ResourcePolicy<TripInput, null> {
  return {
    id: "trip",
    debounceMs: 0,
    maxWaitMs: 0,
    timeoutMs: 10_000,
    staleAfterMs: 0,
    retryAttempts: 3,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 5,
      baseOpenMs: 30_000,
      maxOpenMs: 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.code !== next.code ||
      previous.slot !== next.slot ||
      previous.route !== next.route ||
      previous.profile !== next.profile ||
      previous.dest.lat !== next.dest.lat ||
      previous.dest.lng !== next.dest.lng ||
      nowMs - previousAtMs >= TRIP_REFRESH_MS,
    identity: (input) =>
      `t:${input.code}:${input.slot}:${input.profile}:` +
      `${input.dest.lat},${input.dest.lng}:` +
      `${input.route.duration}:${input.route.distance}`,
    run: async (input, signal) => {
      const result = await ports.writeTrip(
        input.code,
        input.slot,
        {
          lat: input.dest.lat,
          lng: input.dest.lng,
          profile: input.profile,
          duration: input.route.duration,
          distance: input.route.distance,
          line: encodeRouteLine(input.route.geometry),
        },
        signal,
      );
      return result.ok ? ok(null) : err(result.error);
    },
  };
}

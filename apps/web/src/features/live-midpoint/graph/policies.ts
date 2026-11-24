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
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { ResourcePolicy } from "../../../core/dag/resource";
import type { ParticipantIndex } from "../lib/participant-config";
import type { GraphPorts } from "./ports";
import { candidatePoints, pickFairest } from "../lib/fair-meeting";
import { MATRIX_MAX_COORDINATES } from "../lib/matrix-api";
import type {
  MeetingAnswer,
  RouteInfo,
  RouteSet,
  TravelProfile,
} from "./types";

const SEARCH_RADIUS_M = 1_000;
const VENUE_ADMIT_M = 100;
const ROUTE_ADMIT_M = 200;

/** Refresh venues at least this often even while standing still. */
const VENUE_TTL_MS = 5 * 60_000;
/** Routes go stale faster — traffic moves. */
const ROUTE_TTL_MS = 60_000;

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
  /** The meeting point to publish with it — the creator's, else `null`. */
  readonly meet: LatLng | null;
}

function samePoint(a: LatLng | null, b: LatLng | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lat === b.lat && a.lng === b.lng;
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
      // The session is waiting on it: everyone else shows the point this
      // record carries.
      !samePoint(previous.meet, next.meet) ||
      haversineDistance(previous.position, next.position) >= PRESENCE_ADMIT_M ||
      // The heartbeat: peers infer staleness from the age of this write, so it
      // has to keep landing even for someone standing still.
      nowMs - previousAtMs >= PRESENCE_WRITE_MS,
    identity: (input) =>
      `pr:${input.code}:${input.slot}:${input.uid}:${input.name}:` +
      cellKey(input.position, PRESENCE_ADMIT_M) +
      (input.meet === null ? "" : `:${input.meet.lat},${input.meet.lng}`),
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
          meet: input.meet,
        },
        signal,
      );
      return result.ok ? ok(null) : err(result.error);
    },
  };
}

export interface RouteInput {
  /** Slot-keyed positions; `null` is a vacant slot. */
  readonly slots: readonly (LatLng | null)[];
  readonly dest: LatLng;
  readonly profile: TravelProfile;
}

export function occupancyKey(slots: readonly (LatLng | null)[]): string {
  return slots.map((slot) => (slot === null ? "-" : "x")).join("");
}

function anySlotMoved(
  previous: readonly (LatLng | null)[],
  next: readonly (LatLng | null)[],
  thresholdM: number,
): boolean {
  for (let i = 0; i < next.length; i++) {
    const a = previous[i];
    const b = next[i];
    if (a == null || b == null) continue;
    if (haversineDistance(a, b) >= thresholdM) return true;
  }
  return false;
}

export interface MeetingInput {
  /** Slot-keyed positions; `null` is a slot not counted. */
  readonly slots: readonly (LatLng | null)[];
  readonly centroid: LatLng;
  readonly profile: TravelProfile;
  /**
   * The meeting point now shown, if it is the matrix's. Asked about again so a
   * new point has to beat it (`pickFairest`). Never read by `admits` or
   * `identity`: it changes with every answer, and an answer must not be a
   * reason to ask again.
   */
  readonly incumbent: LatLng | null;
}

/** Most candidate points per request, the incumbent included. */
const MEETING_CANDIDATES = 12;
/**
 * How far someone has to move before the meeting point is worked out again:
 * this fraction of their distance to the centroid, and never less than the
 * floor. Relative, because what shifts a time-balanced point is a change in
 * somebody's share of the trip — 500 m matters two kilometres out and not at
 * forty — and because people driving towards it would otherwise re-ask every
 * few seconds, for a point that should hold still while they are on their way.
 * The matrix is billed per source × destination.
 */
const MEETING_ADMIT_FRACTION = 0.2;
const MEETING_ADMIT_MIN_M = 1_000;
/**
 * Ask again after this long whatever has moved. Not for freshness — the
 * matrix uses typical speeds, so the answer would be the same — but because a
 * refusal is recorded as its input's answer (`core/dag/resource.ts`), and with
 * no clause on age a single stray 4xx left two people standing still on the
 * centroid for as long as they stood.
 */
const MEETING_TTL_MS = 10 * 60_000;

function movedEnoughToRebalance(
  previous: MeetingInput,
  next: MeetingInput,
): boolean {
  for (let i = 0; i < next.slots.length; i++) {
    const a = previous.slots[i];
    const b = next.slots[i];
    if (a == null || b == null) continue;
    const threshold = Math.max(
      MEETING_ADMIT_MIN_M,
      MEETING_ADMIT_FRACTION * haversineDistance(a, previous.centroid),
    );
    if (haversineDistance(a, b) >= threshold) return true;
  }
  return false;
}

/** Whether a matrix answer is for the people and travel mode now counted. */
export function meetingAnswers(
  answer: MeetingAnswer,
  slots: readonly (LatLng | null)[],
  profile: TravelProfile,
): boolean {
  return answer.profile === profile && answer.occupancy === occupancyKey(slots);
}

/**
 * The meeting point balanced by travel time: one Matrix request from everyone
 * counted to a handful of candidate points, and the candidate whose longest
 * trip is shortest (`lib/fair-meeting.ts`).
 *
 * Refreshed on age only rarely (`MEETING_TTL_MS`): the matrix uses typical
 * speeds, not live traffic, so the same question has the same answer until
 * somebody moves. A long last-good window for the same reason — a point that was fair ten minutes ago still is,
 * and falling back to the centroid on one failed refresh would move the place
 * people are driving to.
 */
export function createMeetingPolicy(
  ports: GraphPorts,
): ResourcePolicy<MeetingInput, MeetingAnswer> {
  return {
    id: "meeting",
    // Short, so the answer lands inside the routes' and venues' own debounce:
    // they then fetch once, for the balanced point, not for the centroid first.
    debounceMs: 1_000,
    maxWaitMs: 3_000,
    timeoutMs: 8_000,
    staleAfterMs: 10 * 60_000,
    retryAttempts: 2,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 4,
      baseOpenMs: 30_000,
      maxOpenMs: 5 * 60_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.profile !== next.profile ||
      occupancyKey(previous.slots) !== occupancyKey(next.slots) ||
      movedEnoughToRebalance(previous, next) ||
      nowMs - previousAtMs >= MEETING_TTL_MS,
    identity: (input) =>
      `m:${input.profile}:${occupancyKey(input.slots)}:` +
      cellKey(input.centroid, MEETING_ADMIT_MIN_M),
    run: async (
      input,
      signal,
    ): Promise<Result<MeetingAnswer, ResourceError>> => {
      const people = input.slots.filter(
        (position): position is LatLng => position !== null,
      );
      const hasIncumbent = input.incumbent !== null;
      const budget =
        Math.min(MEETING_CANDIDATES, MATRIX_MAX_COORDINATES - people.length) -
        (hasIncumbent ? 1 : 0);
      const sampled = candidatePoints(people, input.centroid, budget);
      const candidates =
        input.incumbent === null ? sampled : [input.incumbent, ...sampled];

      const matrix = await ports.fetchMatrix(
        people,
        candidates,
        input.profile,
        signal,
      );
      if (!matrix.ok) return err(matrix.error);

      const choice = pickFairest(
        matrix.value.durations,
        hasIncumbent ? 0 : null,
      );
      return ok({
        profile: input.profile,
        occupancy: occupancyKey(input.slots),
        point:
          choice === null ? null : (matrix.value.snapped[choice.index] ?? null),
        worstSeconds: choice?.worstSeconds ?? 0,
      });
    },
  };
}

/**
 * Whether a route set still answers the current destination and profile.
 *
 * Within the same radius that decides when to fetch again: a destination that
 * drifted less than that is the one these routes were fetched for, and one
 * that moved further — a venue picked, the midpoint shifted — is not, so its
 * routes and distances would describe somewhere else.
 */
export function routesAnswer(
  set: RouteSet,
  dest: LatLng,
  profile: TravelProfile,
): boolean {
  return (
    set.profile === profile && haversineDistance(set.dest, dest) < ROUTE_ADMIT_M
  );
}

export function createRoutePolicy(
  ports: GraphPorts,
): ResourcePolicy<RouteInput, RouteSet> {
  return {
    id: "routes",
    debounceMs: 3_000,
    maxWaitMs: 9_000,
    timeoutMs: 10_000,
    staleAfterMs: ROUTE_TTL_MS,
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
      // Compare occupancy, not participant count: one person leaving as
      // another joins keeps the count equal but is a different set of routes.
      occupancyKey(previous.slots) !== occupancyKey(next.slots) ||
      haversineDistance(previous.dest, next.dest) >= ROUTE_ADMIT_M ||
      anySlotMoved(previous.slots, next.slots, ROUTE_ADMIT_M) ||
      nowMs - previousAtMs >= ROUTE_TTL_MS,
    identity: (input) =>
      `r:${input.profile}:${cellKey(input.dest, ROUTE_ADMIT_M)}:` +
      occupancyKey(input.slots),

    /**
     * Fan out one request per occupied slot and settle them independently.
     *
     * `Promise.all` used to mean a single 429 discarded every participant's
     * route and left the previous ones on screen with no indication they were
     * stale. Here a failed slot is simply `null` while its neighbours stay
     * fresh; only a total wipeout is reported as a node failure, so a genuine
     * outage still trips the breaker but one bad leg does not.
     */
    run: async (input, signal): Promise<Result<RouteSet, ResourceError>> => {
      const targets: { slot: number; position: LatLng }[] = [];
      input.slots.forEach((position, slot) => {
        if (position !== null) targets.push({ slot, position });
      });

      const settled = await Promise.allSettled(
        targets.map((target) =>
          ports.fetchRoute(target.position, input.dest, input.profile, signal),
        ),
      );

      const bySlot: (RouteInfo | null)[] = input.slots.map(() => null);
      let successes = 0;
      let firstError: ResourceError | null = null;

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const target = targets[i];
        if (outcome === undefined || target === undefined) continue;
        if (outcome.status === "fulfilled") {
          if (outcome.value.ok) {
            bySlot[target.slot] = outcome.value.value;
            successes++;
          } else if (firstError === null) {
            firstError = outcome.value.error;
          }
        } else if (firstError === null) {
          firstError = classifyThrown(outcome.reason);
        }
      }

      if (successes === 0 && firstError !== null) return err(firstError);
      return ok({ dest: input.dest, profile: input.profile, bySlot });
    },
  };
}

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
import type { RouteInfo, RouteSet, TravelProfile } from "./types";
import {
  REFINE_FRACTION,
  keepsIncumbent,
  pickFairest,
  ringCandidates,
  scoreCandidates,
} from "../lib/fair-point";
import type { PublishedMeeting } from "../lib/fair-point";

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

export interface RouteInput {
  /** Slot-keyed positions; `null` is a vacant slot. */
  readonly slots: readonly (LatLng | null)[];
  readonly dest: LatLng;
  readonly profile: TravelProfile;
}

function occupancyKey(slots: readonly (LatLng | null)[]): string {
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

export interface FairInput {
  readonly code: string;
  /** Slot-keyed positions of everyone counted; `null` is anyone else. */
  readonly slots: readonly (LatLng | null)[];
  /** `occupancyMask(slots)` — who this point is fair to. */
  readonly mask: string;
  readonly profile: TravelProfile;
  readonly centroid: LatLng;
  /** Distance from the centroid to the farthest participant. */
  readonly radiusM: number;
  /** The point already published for these people, if there is one. */
  readonly incumbent: LatLng | null;
}

/**
 * Re-evaluate at least this often. The matrix carries no live traffic, so
 * this is not about congestion: it bounds how long a point chosen from old
 * positions can stand when nothing else asked.
 */
const FAIR_TTL_MS = 10 * 60_000;
/** The centroid drifting this far is worth a new evaluation, whatever the scale. */
const FAIR_ADMIT_MIN_M = 500;
/** …or this fraction of the group's radius, when that is larger. */
const FAIR_ADMIT_RADIUS_FRACTION = 0.2;

/**
 * The time-fair meeting point: computed, and published for the session.
 *
 * Only the session's leader — the lowest counted slot — runs this; the runtime
 * offers everyone else `null`. One evaluation is two matrix requests, coarse
 * then fine (see `lib/fair-point.ts`), and a write when the answer changed.
 *
 * **Admission is on the centroid, not on anyone's position.** While people
 * drive towards the point their positions change constantly and the centroid
 * hardly at all, and that is exactly when the point must hold still. Keyed on
 * positions like the routes are, a half-hour trip was sixty evaluations — a
 * matrix is billed per element — each one a chance to move the destination
 * under people already navigating to it. Keyed on the centroid it is a
 * handful: the first, and one each time the group's centre has genuinely
 * shifted, as when only one of them has set off.
 *
 * **The incumbent is a candidate.** The published point is scored in the same
 * matrix as the new best and kept unless it is beaten by a margin
 * (`keepsIncumbent`), so the point is sticky by construction rather than by a
 * timer. `admits` ignores the incumbent: this node's own write changes it, and
 * admitting on that would be the node re-triggering itself.
 *
 * `staleAfterMs: 0`: nothing reads this resource's value. What every client
 * uses, the leader included, is the point as read back from the database, so
 * there is one source of truth and a refused write shows as no point at all.
 */
export function createFairPolicy(
  ports: GraphPorts,
): ResourcePolicy<FairInput, PublishedMeeting | null> {
  return {
    id: "meeting",
    debounceMs: 4_000,
    maxWaitMs: 12_000,
    timeoutMs: 15_000,
    staleAfterMs: 0,
    retryAttempts: 2,
    retryBaseMs: 1_000,
    breaker: {
      failureThreshold: 4,
      baseOpenMs: 30_000,
      maxOpenMs: 120_000,
      multiplier: 2,
    },
    admits: (previous, next, previousAtMs, nowMs) =>
      previous.code !== next.code ||
      previous.profile !== next.profile ||
      previous.mask !== next.mask ||
      haversineDistance(previous.centroid, next.centroid) >=
        Math.max(
          FAIR_ADMIT_MIN_M,
          previous.radiusM * FAIR_ADMIT_RADIUS_FRACTION,
        ) ||
      nowMs - previousAtMs >= FAIR_TTL_MS,
    identity: (input) =>
      `m:${input.code}:${input.profile}:${input.mask}:` +
      cellKey(input.centroid, FAIR_ADMIT_MIN_M),

    run: async (
      input,
      signal,
    ): Promise<Result<PublishedMeeting | null, ResourceError>> => {
      const sources = input.slots.filter(
        (position): position is LatLng => position !== null,
      );

      // Round one: the whole group's extent, around its centroid.
      const coarse = ringCandidates(input.centroid, input.radiusM);
      const first = await ports.fetchMatrix(
        sources,
        coarse,
        input.profile,
        signal,
      );
      if (!first.ok) return err(first.error);
      const coarseBest = pickFairest(
        scoreCandidates(first.value.durations, first.value.destinations),
      );
      // Nowhere everyone can reach: no fair point, and the centroid stands.
      if (coarseBest === null) return ok(null);

      // Round two: a third of that extent, around round one's best. The
      // incumbent rides along last, so it is judged by the same matrix as
      // whatever might replace it.
      const fine = ringCandidates(
        coarseBest.point,
        input.radiusM * REFINE_FRACTION,
      );
      const candidates =
        input.incumbent === null ? fine : [...fine, input.incumbent];
      const second = await ports.fetchMatrix(
        sources,
        candidates,
        input.profile,
        signal,
      );
      if (!second.ok) return err(second.error);
      const scored = scoreCandidates(
        second.value.durations,
        second.value.destinations,
      );
      const best = pickFairest(scored.slice(0, fine.length));
      if (best === null) return ok(null);

      const incumbent =
        input.incumbent === null ? null : (scored[fine.length] ?? null);
      if (
        input.incumbent !== null &&
        incumbent !== null &&
        keepsIncumbent(incumbent, best)
      ) {
        // Kept as published — the coordinates that are in the database, not
        // the router's re-snapping of them — so there is nothing to write.
        return ok({ point: input.incumbent, mask: input.mask });
      }

      const meeting: PublishedMeeting = { point: best.point, mask: input.mask };
      const written = await ports.writeMeeting(input.code, meeting, signal);
      return written.ok ? ok(meeting) : err(written.error);
    },
  };
}

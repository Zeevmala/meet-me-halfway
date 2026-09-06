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
import type { GraphPorts } from "./ports";
import type { RouteInfo, TravelProfile } from "./types";

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
  readonly uid: string;
  readonly position: LatLng;
  readonly accuracy: number;
  readonly name: string;
}

/** One RTDB write per this window, matching the old WRITE_THROTTLE_MS. */
const PRESENCE_WRITE_MS = 3_000;
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
      previous.uid !== next.uid ||
      previous.name !== next.name ||
      haversineDistance(previous.position, next.position) >= PRESENCE_ADMIT_M ||
      // The heartbeat: peers infer staleness from the age of this write, so it
      // has to keep landing even for someone standing still.
      nowMs - previousAtMs >= PRESENCE_WRITE_MS,
    identity: (input) =>
      `pr:${input.code}:${input.uid}:${input.name}:` +
      cellKey(input.position, PRESENCE_ADMIT_M),
    run: async (input, signal) => {
      const result = await ports.writePresence(
        input.code,
        input.uid,
        {
          lat: input.position.lat,
          lng: input.position.lng,
          accuracy: input.accuracy,
          ts: Date.now(),
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

export function createRoutePolicy(
  ports: GraphPorts,
): ResourcePolicy<RouteInput, (RouteInfo | null)[]> {
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
    run: async (
      input,
      signal,
    ): Promise<Result<(RouteInfo | null)[], ResourceError>> => {
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
      return ok(bySlot);
    },
  };
}

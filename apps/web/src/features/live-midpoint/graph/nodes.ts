/**
 * Pure derivations. No I/O, no timers, no React — every one of these is a
 * plain function of its inputs, which is what makes them testable without
 * mounting anything.
 */
import { geographicCentroid } from "../lib/geo-math";
import type { LatLng } from "../lib/geo-math";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import type { ParticipantIndex } from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";
import type {
  DestinationResult,
  GraphSources,
  LivenessResult,
  ParticipantSource,
  SessionPhase,
  SessionStatus,
  SlotVector,
} from "./types";

/** A participant whose last write is older than this is shown as stale. */
export const STALE_THRESHOLD_MS = 30_000;

/**
 * A participant silent this long has left, as far as the meeting point is
 * concerned: still drawn, dimmed, but no longer pulling the midpoint or
 * getting a route. Their node should be gone already — the disconnect cleanup
 * removes it — so this covers the cases it cannot: a tab still connected but
 * frozen in the background, or a phone that stopped reporting.
 */
export const DEPARTED_THRESHOLD_MS = 120_000;

/**
 * Fold own position and every participant into slot-indexed parallel arrays
 * in a single pass.
 *
 * Own position is only placed when its slot is known. Before that the session
 * has not resolved, so there are no other participants and therefore no
 * midpoint to compute — dropping it is preferable to guessing slot 0, which
 * is reserved for the creator and would mis-colour every joiner.
 */
export function buildSlotVector(
  sources: GraphSources,
  liveness: LivenessResult,
): SlotVector {
  const positions: (LatLng | null)[] = new Array(MAX_PARTICIPANTS).fill(null);
  const accuracy: number[] = new Array(MAX_PARTICIPANTS).fill(0);
  const names: (string | null)[] = new Array(MAX_PARTICIPANTS).fill(null);
  const occupied: ParticipantIndex[] = [];
  const counted: ParticipantIndex[] = [];

  const ownSlot = sources.ownSlot;
  if (ownSlot !== null && sources.ownPosition !== null) {
    positions[ownSlot] = sources.ownPosition;
    accuracy[ownSlot] = sources.ownAccuracy ?? 0;
  }

  for (const participant of sources.participants) {
    const slot = participant.index;
    if (slot < 0 || slot >= MAX_PARTICIPANTS) continue;
    positions[slot] = participant.position;
    accuracy[slot] = participant.accuracy;
    names[slot] = participant.name;
  }

  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (positions[i] === null) continue;
    occupied.push(i as ParticipantIndex);
    if (i === ownSlot || liveness.departed[i] !== true) {
      counted.push(i as ParticipantIndex);
    }
  }

  return {
    positions,
    accuracy,
    stale: liveness.stale,
    departed: liveness.departed,
    names,
    occupied,
    counted,
    ownSlot,
  };
}

/**
 * A participant is stale once their last write is older than the threshold.
 *
 * The second return value is what makes this cheap: `nextFlipAtMs` is the
 * earliest instant at which some participant turns stale or departs, so the
 * runtime arms exactly one timer for it instead of polling. Recomputing from
 * the clock on every tick also means a tab that was backgrounded for ten
 * minutes reports the truth on its first tick back, which the 10s
 * `setInterval` this replaces could not: mobile browsers throttle it to
 * minutes and freeze it entirely under bfcache. That is the same reasoning
 * `core/dag/breaker.ts` gives for holding no timer of its own.
 *
 * `nowMs` must be the server's clock. `lastSeen` is stamped by the server, and
 * device clocks run minutes off on some phones: measured against one, a fresh
 * peer looked stale on a slow phone and a departed one looked live on a fast
 * one.
 */
export function deriveLiveness(
  participants: readonly ParticipantSource[],
  nowMs: number,
): LivenessResult {
  const stale: boolean[] = new Array(MAX_PARTICIPANTS).fill(false);
  const departed: boolean[] = new Array(MAX_PARTICIPANTS).fill(false);
  let nextFlipAtMs: number | null = null;

  for (const participant of participants) {
    const slot = participant.index;
    if (slot < 0 || slot >= MAX_PARTICIPANTS) continue;

    // `>=`, not `>`. The runtime arms a wake for exactly `flipAtMs`, so the
    // predicate has to be true when that wake fires. With a strict `>` the
    // participant was still fresh at that instant, `nextFlipAtMs` came back as
    // the same now-current timestamp, and the wake re-armed at a zero delay —
    // the same livelock `core/dag/breaker.ts` has at its half-open boundary.
    const staleAtMs = participant.lastSeen + STALE_THRESHOLD_MS;
    const departedAtMs = participant.lastSeen + DEPARTED_THRESHOLD_MS;
    stale[slot] = nowMs >= staleAtMs;
    departed[slot] = nowMs >= departedAtMs;

    const flipAtMs =
      nowMs < staleAtMs
        ? staleAtMs
        : nowMs < departedAtMs
          ? departedAtMs
          : null;
    if (
      flipAtMs !== null &&
      (nextFlipAtMs === null || flipAtMs < nextFlipAtMs)
    ) {
      nextFlipAtMs = flipAtMs;
    }
  }

  return { stale, departed, nextFlipAtMs };
}

/**
 * The phase the UI renders.
 *
 * Previously a `useState` written from six places — the RTDB listener, the
 * stale interval, and the create/join paths — which is how a `setPhase` ended
 * up being called from inside a `setParticipants` updater, where React
 * requires purity and StrictMode double-invokes. It is a total function of the
 * lifecycle status, the roster and liveness, so it is derived.
 */
export function derivePhase(
  status: SessionStatus,
  slots: SlotVector,
  liveness: LivenessResult,
): SessionPhase {
  switch (status) {
    case "error":
      return "error";
    case "idle":
      return "idle";
    case "connecting":
      return "creating";
    case "ready":
      break;
  }

  // Departed peers are drawn but do not count: one who has been silent for
  // minutes is not someone the session is "connected" to.
  let others = 0;
  let anyStale = false;
  for (const slot of slots.counted) {
    if (slot === slots.ownSlot) continue;
    others++;
    if (liveness.stale[slot] === true) anyStale = true;
  }

  if (others === 0) return "waiting";
  return anyStale ? "some_stale" : "connected";
}

/**
 * Geographic centroid of every counted slot — occupied and not departed.
 *
 * A departed participant used to pull the midpoint for as long as their node
 * stayed in the database, towards wherever they were last seen.
 *
 * Fewer than two participants is a normal waiting state, not a failure, so
 * this returns `null` rather than an error. The guard also keeps
 * `geographicCentroid` — which throws on an empty array — unreachable in that
 * state.
 */
export function deriveMidpoint(slots: SlotVector): LatLng | null {
  const points: LatLng[] = [];
  for (const slot of slots.counted) {
    const position = slots.positions[slot];
    if (position) points.push(position);
  }
  if (points.length < 2) return null;
  return geographicCentroid(points);
}

/**
 * Resolve the meeting point: the selected venue if it still exists in the
 * current results, otherwise the midpoint.
 *
 * This is a derivation rather than a write-back, which is the whole point.
 * Reconciliation used to be an effect that cleared the selection only when
 * `venues.length > 0`, so a search returning no results left a deleted venue
 * pinned as the destination indefinitely. Deriving it means an absent venue
 * simply cannot be the destination, and there is no second source of truth to
 * fall out of sync with the list highlight.
 */
export function deriveDestination(
  venues: readonly RankedVenue[],
  selectedVenueId: string | null,
  midpoint: LatLng | null,
): DestinationResult {
  if (selectedVenueId === null) {
    return { destination: midpoint, selectedVenue: null };
  }
  const selected = venues.find((venue) => venue.id === selectedVenueId) ?? null;
  return {
    destination: selected ? selected.location : midpoint,
    selectedVenue: selected,
  };
}

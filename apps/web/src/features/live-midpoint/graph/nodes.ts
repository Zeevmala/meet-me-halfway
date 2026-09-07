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
import type { DestinationResult, GraphSources, SlotVector } from "./types";

/**
 * Fold own position and every participant into slot-indexed parallel arrays
 * in a single pass.
 *
 * Own position is only placed when its slot is known. Before that the session
 * has not resolved, so there are no other participants and therefore no
 * midpoint to compute — dropping it is preferable to guessing slot 0, which
 * is reserved for the creator and would mis-colour every joiner.
 */
export function buildSlotVector(sources: GraphSources): SlotVector {
  const positions: (LatLng | null)[] = new Array(MAX_PARTICIPANTS).fill(null);
  const accuracy: number[] = new Array(MAX_PARTICIPANTS).fill(0);
  const stale: boolean[] = new Array(MAX_PARTICIPANTS).fill(false);
  const names: (string | null)[] = new Array(MAX_PARTICIPANTS).fill(null);
  const occupied: ParticipantIndex[] = [];

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
    stale[slot] = participant.stale;
    names[slot] = participant.name;
  }

  for (let i = 0; i < MAX_PARTICIPANTS; i++) {
    if (positions[i] !== null) occupied.push(i as ParticipantIndex);
  }

  return { positions, accuracy, stale, names, occupied, ownSlot };
}

/**
 * Geographic centroid of every occupied slot.
 *
 * Fewer than two participants is a normal waiting state, not a failure, so
 * this returns `null` rather than an error. The guard also keeps
 * `geographicCentroid` — which throws on an empty array — unreachable in that
 * state.
 */
export function deriveMidpoint(slots: SlotVector): LatLng | null {
  const points: LatLng[] = [];
  for (const slot of slots.occupied) {
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

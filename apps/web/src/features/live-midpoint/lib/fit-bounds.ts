/**
 * Jitter suppression for the map's `fitBounds`.
 *
 * The set of points to frame is heterogeneous — participants, the midpoint,
 * and the selected venue — so it must be compared **by identity, not by
 * position**. The previous guard held a plain `LatLng[]` and compared
 * `prev[i]` to `current[i]`: a participant joining in the same commit that a
 * venue was deselected keeps the two lengths equal while every index past the
 * newcomer now denotes something else, so the guard measured a participant
 * against a venue and could suppress a refit that was genuinely needed. That
 * is the same aliasing class as the route/colour misalignment that stable slot
 * identity already fixed.
 */
import { haversineDistance } from "./geo-math";
import type { LatLng } from "./geo-math";
import type { RankedVenue } from "./venue-ranking";
import type { MapParticipant } from "../graph/types";

/** Identity-keyed set of the points a fit should frame. */
export type FitSignature = ReadonlyMap<string, LatLng>;

export function fitSignature(
  participants: readonly MapParticipant[],
  midpoint: LatLng | null,
  selectedVenue: RankedVenue | null,
): Map<string, LatLng> {
  const signature = new Map<string, LatLng>();
  for (const participant of participants) {
    signature.set(`slot:${participant.index}`, participant.position);
  }
  if (midpoint !== null) signature.set("midpoint", midpoint);
  if (selectedVenue !== null) {
    signature.set(`venue:${selectedVenue.id}`, selectedVenue.location);
  }
  return signature;
}

/**
 * Whether the frame can be left alone: the same entities are present and none
 * has moved as far as `thresholdM`. Any appearance, disappearance or identity
 * change is a refit, regardless of distance.
 */
export function hasSettled(
  previous: FitSignature,
  next: FitSignature,
  thresholdM: number,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [key, point] of next) {
    const before = previous.get(key);
    if (before === undefined) return false;
    if (haversineDistance(before, point) >= thresholdM) return false;
  }
  return true;
}

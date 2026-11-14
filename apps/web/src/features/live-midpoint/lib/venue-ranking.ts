/**
 * Venue ranking formula for nearby POI search results.
 * Pure scoring functions — no external deps beyond geo-math.
 */

import type { LatLng } from "./geo-math";
import { haversineDistance } from "./geo-math";

export interface PlaceResult {
  id: string;
  displayName: string;
  location: LatLng;
  rating: number;
  userRatingCount: number;
  openNow: boolean;
  types: string[];
  formattedAddress?: string;
  distanceFromMidpoint?: number;
}

export interface RankedVenue extends PlaceResult {
  score: number;
}

/**
 * Compute composite venue score (0.0–1.0).
 *
 * Weights:
 *   0.40 — rating (normalized 0–5 → 0–1)
 *   0.30 — proximity (1 = at midpoint, 0 = at maxDistance)
 *   0.20 — popularity (capped at 200 ratings)
 *   0.10 — open now bonus
 *
 * @param place - Place with distanceFromMidpoint already set
 * @param maxDistance - Maximum distance in the result set (meters)
 */
export function computeVenueScore(
  place: PlaceResult,
  maxDistance: number,
): number {
  const ratingComponent = 0.4 * (place.rating / 5.0);

  const dist = place.distanceFromMidpoint ?? 0;
  const distanceComponent =
    maxDistance > 0 ? 0.3 * (1 - dist / maxDistance) : 0.3;

  const popularityComponent = 0.2 * Math.min(1, place.userRatingCount / 200);

  const openNowComponent = 0.1 * (place.openNow ? 1 : 0);

  return (
    ratingComponent + distanceComponent + popularityComponent + openNowComponent
  );
}

/**
 * Rank and sort venues by composite score (descending).
 * Computes distanceFromMidpoint for each place, then scores and slices.
 *
 * @param places - Raw place results from API
 * @param midpoint - Search center for distance computation
 * @param topN - Maximum venues to return (default 5)
 */
export function rankVenues(
  places: readonly PlaceResult[],
  midpoint: LatLng,
  topN: number = 5,
): RankedVenue[] {
  if (places.length === 0) return [];

  const withDistance = places.map((p) => ({
    ...p,
    distanceFromMidpoint: haversineDistance(midpoint, p.location),
  }));

  const maxDistance = Math.max(
    ...withDistance.map((p) => p.distanceFromMidpoint),
  );

  return withDistance
    .map((p) => ({
      ...p,
      score: computeVenueScore(p, maxDistance),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/**
 * The top `topN`, plus the venue the user picked, wherever it now ranks.
 *
 * A pick is a decision, not a ranking. Scores are relative to the live
 * midpoint, so a venue near the cut-off moved in and out of the top `topN` as
 * people walked — and the pick, found by looking it up in that list, went with
 * it: the destination flipped between the venue and the midpoint with no
 * search at all. Pinned, it stays listed, and clearable, until it is cleared.
 *
 * The pick is ranked from the latest results while they still hold it, and
 * from the place as it was picked once they do not: a later search around a
 * moved midpoint may no longer return it.
 */
export function rankWithPinned(
  places: readonly PlaceResult[],
  midpoint: LatLng,
  topN: number,
  pinned: PlaceResult | null,
): RankedVenue[] {
  const all = rankVenues(places, midpoint, places.length);
  const top = all.slice(0, topN);
  if (pinned === null || top.some((venue) => venue.id === pinned.id)) {
    return top;
  }
  const ranked =
    all.find((venue) => venue.id === pinned.id) ??
    rankAmong(pinned, midpoint, all);
  return [...top, ranked];
}

/**
 * Score one place on the same scale as `others` — proximity relative to the
 * farthest of them — so its score sorts among theirs. A place farther than
 * all of them scores no proximity at all.
 */
function rankAmong(
  place: PlaceResult,
  midpoint: LatLng,
  others: readonly RankedVenue[],
): RankedVenue {
  const distanceFromMidpoint = haversineDistance(midpoint, place.location);
  const maxDistance = Math.max(
    distanceFromMidpoint,
    ...others.map((venue) => venue.distanceFromMidpoint ?? 0),
  );
  const withDistance = { ...place, distanceFromMidpoint };
  return {
    ...withDistance,
    score: computeVenueScore(withDistance, maxDistance),
  };
}

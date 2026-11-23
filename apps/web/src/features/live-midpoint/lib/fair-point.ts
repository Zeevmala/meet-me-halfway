/**
 * The meeting point that is fair in time, not distance.
 *
 * The geographic centroid is halfway in kilometres, and a kilometre of
 * motorway is not a kilometre of city centre: two people "meeting halfway"
 * routinely arrive twenty minutes apart. What people mean by halfway is that
 * nobody's trip is much longer than anyone else's, which is the minimax
 * problem on the road network — the 1-centre: the place that minimises the
 * longest travel time.
 *
 * It is solved by sampling, coarse then fine. Candidates are laid out in rings
 * around a centre, a travel-time matrix (every participant to every candidate)
 * scores them, and the best one becomes the centre of a tighter second round.
 * Everything here is the pure half: geometry in, choice out. The matrix call
 * and the write live behind ports, in `graph/policies.ts`.
 */
import { destinationPoint, haversineDistance } from "./geo-math";
import type { LatLng } from "./geo-math";

/**
 * Candidates per round: a centre and three rings of six.
 *
 * The Matrix API takes 25 coordinates per request. Five participants leave 20
 * destinations — these 19 and the incumbent.
 */
export const RING_COUNT = 3;
export const POINTS_PER_RING = 6;
export const CANDIDATES_PER_ROUND = 1 + RING_COUNT * POINTS_PER_RING;

/** The second round searches this fraction of the first round's radius. */
export const REFINE_FRACTION = 1 / 3;

/**
 * People this close together are already there: the centroid is within a
 * short walk of everyone, and no matrix call could improve on it.
 */
export const FAIR_MIN_RADIUS_M = 500;

/**
 * How much better a new point must be to displace the one already published:
 * the larger of 90 seconds and a tenth of the longest trip.
 *
 * Without it the point follows every re-evaluation, and a destination that
 * moves while people are driving to it is not a destination. With it, once a
 * point is chosen it holds for as long as it stays near enough to the best —
 * which it does while everyone converges on it.
 */
const KEEP_MARGIN_S = 90;
const KEEP_MARGIN_FRACTION = 0.1;

/**
 * Which slots a meeting point was computed for, as five `0`/`1` characters
 * indexed by slot: `"10100"` is slots 0 and 2.
 *
 * It travels with the published point. A client uses a point only while its
 * mask matches the people it counts, and the security rules read the mask to
 * decide who may publish — the holder of its lowest slot.
 */
export function occupancyMask(positions: readonly (LatLng | null)[]): string {
  return positions.map((position) => (position === null ? "0" : "1")).join("");
}

/** Distance from `centre` to the farthest position, in metres. */
export function spreadRadius(
  centre: LatLng,
  positions: readonly (LatLng | null)[],
): number {
  let radius = 0;
  for (const position of positions) {
    if (position === null) continue;
    radius = Math.max(radius, haversineDistance(centre, position));
  }
  return radius;
}

/**
 * A centre and three concentric rings of six, the outermost at `outerRadiusM`.
 *
 * The middle ring is turned 30° so that its points fall between the others'
 * spokes — a hexagonal packing, which covers a disc with fewer samples than
 * aligned spokes do. The centre is first on purpose: `pickFairest` breaks ties
 * towards the earliest candidate, so when nothing beats the centre the answer
 * is the centre.
 */
export function ringCandidates(centre: LatLng, outerRadiusM: number): LatLng[] {
  const candidates: LatLng[] = [centre];
  for (let ring = 1; ring <= RING_COUNT; ring++) {
    const radius = (outerRadiusM * ring) / RING_COUNT;
    const offset = ring % 2 === 0 ? 180 / POINTS_PER_RING : 0;
    for (let i = 0; i < POINTS_PER_RING; i++) {
      candidates.push(
        destinationPoint(centre, offset + (360 / POINTS_PER_RING) * i, radius),
      );
    }
  }
  return candidates;
}

/** One candidate as the matrix scored it. */
export interface ScoredCandidate {
  /** Where the router put it: the candidate snapped to the road network. */
  readonly point: LatLng;
  /** The longest trip to it, in seconds — what fairness minimises. */
  readonly worstS: number;
  readonly meanS: number;
}

/**
 * Score every candidate from a travel-time matrix: `durations[i][j]` is
 * seconds from participant `i` to candidate `j`, `null` where the router found
 * no route.
 *
 * A candidate somebody cannot reach scores `null` and can never be chosen. The
 * result stays index-aligned with the candidates so a caller can find the one
 * it cares about — the incumbent — by position.
 */
export function scoreCandidates(
  durations: readonly (readonly (number | null)[])[],
  snapped: readonly LatLng[],
): (ScoredCandidate | null)[] {
  return snapped.map((point, j) => {
    let worstS = 0;
    let totalS = 0;
    for (const row of durations) {
      const seconds = row[j];
      if (seconds === null || seconds === undefined) return null;
      worstS = Math.max(worstS, seconds);
      totalS += seconds;
    }
    if (durations.length === 0) return null;
    return { point, worstS, meanS: totalS / durations.length };
  });
}

/**
 * The fairest candidate: the shortest longest trip, then the shortest average,
 * then the earliest in the list.
 *
 * Minimising the *spread* alone would be the wrong objective — somewhere an
 * hour from everyone is perfectly even. Minimising the longest trip is what
 * equalises: for two people it lands where their travel times cross.
 */
export function pickFairest(
  scored: readonly (ScoredCandidate | null)[],
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const candidate of scored) {
    if (candidate === null) continue;
    if (
      best === null ||
      candidate.worstS < best.worstS ||
      (candidate.worstS === best.worstS && candidate.meanS < best.meanS)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** Whether the published point is still near enough to the best to keep. */
export function keepsIncumbent(
  incumbent: ScoredCandidate,
  best: ScoredCandidate,
): boolean {
  const margin = Math.max(KEEP_MARGIN_S, best.worstS * KEEP_MARGIN_FRACTION);
  return incumbent.worstS <= best.worstS + margin;
}

/** A meeting point as the session carries it. */
export interface PublishedMeeting {
  readonly point: LatLng;
  /** The slots it was computed for — see `occupancyMask`. */
  readonly mask: string;
}

/**
 * Whether a published point answers the people counted right now.
 *
 * Two checks, neither of them a clock. The mask: a point computed before
 * someone joined or left is fair to a different group. And the distance: a
 * minimax point lies among the people it serves, so one further from their
 * centroid than they are — left over from wherever the group was an hour ago,
 * while the matrix was unreachable — is not theirs. The slack covers the
 * router snapping a candidate to the nearest road.
 */
export function acceptsMeeting(
  published: PublishedMeeting,
  mask: string,
  centroid: LatLng,
  radiusM: number,
): boolean {
  if (published.mask !== mask) return false;
  const reach = Math.max(radiusM * 1.5, FAIR_MIN_RADIUS_M * 2);
  return haversineDistance(published.point, centroid) <= reach;
}

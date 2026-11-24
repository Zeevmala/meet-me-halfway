/**
 * The meeting point balanced by travel time, as pure functions.
 *
 * The geographic centroid is halfway in distance, which is rarely halfway in
 * time: one person on a motorway and one crossing a city reach it half an hour
 * apart. This picks, from a set of candidate points, the one whose *longest*
 * trip is shortest — the minimax (1-centre) point over travel time — so nobody
 * travels much longer than anyone else has to.
 *
 * Minimising the gap between arrivals alone would be the wrong objective: a
 * point an hour beyond everyone has a gap of zero. Minimising the worst trip
 * equalises the two longest trips as a consequence, and keeps the point
 * between people.
 *
 * The candidates are sampled, not searched: the centroid and points on the
 * way from it to each person. A candidate is only a place to ask about — the
 * matrix snaps each to the road network and the snapped point is what gets
 * chosen, so the result is somewhere a car can reach, which the centroid (a
 * field, a lake) often was not.
 */
import { interpolate } from "./geo-math";
import type { LatLng } from "./geo-math";

/**
 * How far towards each person the candidates reach, as a fraction of the way
 * from the centroid. For two people that covers 20%–80% of the line between
 * them: a time-fair point outside that would have one person travelling four
 * times as long as the other in distance, to come out even in time.
 */
const MAX_REACH = 0.6;

/** Weight of the mean trip, breaking ties between equal worst trips. */
const MEAN_WEIGHT = 0.25;

/**
 * A new point must beat the current one by this much — in seconds, and as a
 * fraction of the current worst trip — before the meeting point moves.
 *
 * Without it the point hops between neighbouring candidates as people drive:
 * each hop re-runs venue search and every route, and moves the place people
 * are already heading for, to save anyone seconds.
 */
const SWITCH_MIN_GAIN_S = 60;
const SWITCH_MIN_GAIN_FRACTION = 0.05;

/**
 * Candidate meeting points: the centroid first, then `perPerson` points on
 * the way from it to each person.
 *
 * @param budget - the most candidates to return (at least 1)
 */
export function candidatePoints(
  people: readonly LatLng[],
  centroid: LatLng,
  budget: number,
): LatLng[] {
  const out: LatLng[] = [centroid];
  if (people.length === 0) return out;
  const perPerson = Math.floor((budget - 1) / people.length);
  for (const person of people) {
    for (let step = 1; step <= perPerson; step++) {
      out.push(interpolate(centroid, person, (MAX_REACH * step) / perPerson));
    }
  }
  return out;
}

export interface FairChoice {
  /** Index into the candidates the durations were asked for. */
  readonly index: number;
  /** The longest trip to it, seconds. */
  readonly worstSeconds: number;
}

/** A candidate's cost, or `null` if somebody has no route to it. */
function cost(
  durations: readonly (readonly (number | null)[])[],
  candidate: number,
): { cost: number; worst: number } | null {
  let worst = 0;
  let sum = 0;
  for (const row of durations) {
    const seconds = row[candidate];
    if (seconds === null || seconds === undefined) return null;
    if (seconds > worst) worst = seconds;
    sum += seconds;
  }
  if (durations.length === 0) return null;
  return { cost: worst + MEAN_WEIGHT * (sum / durations.length), worst };
}

/**
 * The fairest candidate, or `null` when no candidate is reachable by everyone.
 *
 * @param durations - `durations[person][candidate]`, seconds
 * @param incumbentIndex - the candidate that is the current meeting point, if
 *   it is among them: kept unless another beats it by the switching margin
 */
export function pickFairest(
  durations: readonly (readonly (number | null)[])[],
  incumbentIndex: number | null = null,
): FairChoice | null {
  const candidates = durations[0]?.length ?? 0;
  let best: { index: number; cost: number; worst: number } | null = null;
  let incumbent: { index: number; cost: number; worst: number } | null = null;

  for (let index = 0; index < candidates; index++) {
    const scored = cost(durations, index);
    if (scored === null) continue;
    if (index === incumbentIndex) incumbent = { index, ...scored };
    // Strict: among equals the earliest wins, and the centroid is first.
    if (best === null || scored.cost < best.cost) best = { index, ...scored };
  }

  if (best === null) return null;
  if (incumbent !== null && best.index !== incumbent.index) {
    const margin = Math.max(
      SWITCH_MIN_GAIN_S,
      SWITCH_MIN_GAIN_FRACTION * incumbent.cost,
    );
    if (incumbent.cost - best.cost < margin) best = incumbent;
  }
  return { index: best.index, worstSeconds: best.worst };
}

/**
 * Arrival times, as the midpoint card shows them.
 *
 * Time leads there, not distance: whether to leave now depends on how long
 * the trip takes, and 22 km can be 20 minutes or an hour.
 */

/** Whole minutes, rounded up as the card always has: 61 s reads "2 min". */
export function etaMinutes(seconds: number): number {
  return Math.ceil(seconds / 60);
}

/** An ETA split for display: "1 h 15 min" reads where "75 min" makes you count. */
export function etaParts(seconds: number): { hours: number; minutes: number } {
  const total = etaMinutes(seconds);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/**
 * How far apart the arrivals are: the latest ETA minus the earliest, in
 * minutes. `null` until two people have a route — one is no comparison.
 *
 * The midpoint is geographic, so this is rarely zero: halfway in distance is
 * not halfway in time. Showing the gap is the honest half of that; closing
 * it — a meeting point balanced by travel time — is a routing problem of its
 * own.
 */
export function etaSpreadMinutes(
  routes: readonly ({ readonly duration: number } | null)[],
): number | null {
  const minutes = routes.flatMap((route) =>
    route === null ? [] : [etaMinutes(route.duration)],
  );
  if (minutes.length < 2) return null;
  return Math.max(...minutes) - Math.min(...minutes);
}

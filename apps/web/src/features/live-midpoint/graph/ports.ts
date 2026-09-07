/**
 * The graph's I/O seam. Every effectful dependency arrives here rather than
 * being imported by the node that uses it, so tests supply a fake object
 * instead of mocking modules or globals — and time is data, not a fake timer.
 *
 * `placesEnabled` is configuration rather than an `import.meta.env` read at
 * the point of use. It was previously read in three separate places, which
 * made the venue path awkward to exercise.
 */
import type { LatLng } from "../lib/geo-math";
import type { PlaceResult } from "../lib/venue-ranking";
import { searchNearbyVenues } from "../lib/places-api";
import { fetchRoute } from "../lib/directions-api";
import type { Result } from "../../../core/dag/result";
import type { ResourceError } from "../../../core/dag/errors";
import type { TimerId } from "../../../core/dag/resource";
import type { RouteInfo, TravelProfile } from "./types";

export interface GraphPorts {
  readonly now: () => number;
  readonly schedule: (fn: () => void, ms: number) => TimerId;
  readonly cancel: (id: TimerId) => void;
  readonly searchVenues: (
    center: LatLng,
    radiusMeters: number,
    signal: AbortSignal,
  ) => Promise<Result<PlaceResult[], ResourceError>>;
  readonly fetchRoute: (
    from: LatLng,
    to: LatLng,
    profile: TravelProfile,
    signal: AbortSignal,
  ) => Promise<Result<RouteInfo | null, ResourceError>>;
  readonly placesEnabled: boolean;
}

export function createDefaultPorts(): GraphPorts {
  return {
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (id) => clearTimeout(id),
    searchVenues: searchNearbyVenues,
    fetchRoute,
    placesEnabled: !!import.meta.env.VITE_GOOGLE_PLACES_API_KEY,
  };
}

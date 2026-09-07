/**
 * The graph's I/O seam. Every effectful dependency arrives here rather than
 * being imported by the node that uses it, so tests supply a fake object
 * instead of mocking modules or globals — and time is data, not a fake timer.
 *
 * Construction lives in `lib/services.ts`, the composition root. Nothing in
 * this file reads the environment: `placesEnabled` is derived from the bound
 * client's key, so the flag and the client can no longer disagree about
 * whether the feature is on — they did, across three separate reads of
 * `VITE_GOOGLE_PLACES_API_KEY`.
 */
import type { LatLng } from "../lib/geo-math";
import type { PlaceResult } from "../lib/venue-ranking";
import type { Result } from "../../../core/dag/result";
import type { ResourceError } from "../../../core/dag/errors";
import type { TimerId } from "../../../core/dag/resource";
import type { PresenceValue } from "../lib/presence-rtdb";
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
  /**
   * Publish own location. A write rather than a read, but it reaches the graph
   * through the same seam so a test can drive the presence node with a fake
   * and a virtual clock instead of mocking `firebase/database`.
   */
  readonly writePresence: (
    code: string,
    uid: string,
    value: PresenceValue,
    signal: AbortSignal,
  ) => Promise<Result<void, ResourceError>>;
  readonly placesEnabled: boolean;
}

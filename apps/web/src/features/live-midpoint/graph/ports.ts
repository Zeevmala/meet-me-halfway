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
import type { ParticipantIndex } from "../lib/participant-config";
import type { PresenceValue } from "../lib/presence-rtdb";
import type { MatrixResult } from "../lib/matrix-api";
import type { PublishedMeeting } from "../lib/fair-point";
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
   * Publish own location at the claimed slot. A write rather than a read, but
   * it reaches the graph through the same seam so a test can drive the
   * presence node with a fake and a virtual clock instead of mocking
   * `firebase/database`.
   *
   * Keyed by slot, not uid: the slot is the server-arbitrated claim, so the
   * rule guarding this path is just "you may write `participants/{i}` iff
   * `slots/{i}` is your uid".
   */
  readonly writePresence: (
    code: string,
    slot: ParticipantIndex,
    value: PresenceValue,
    signal: AbortSignal,
  ) => Promise<Result<void, ResourceError>>;
  /** Travel times from every source to every destination, in one request. */
  readonly fetchMatrix: (
    sources: readonly LatLng[],
    destinations: readonly LatLng[],
    profile: TravelProfile,
    signal: AbortSignal,
  ) => Promise<Result<MatrixResult, ResourceError>>;
  /**
   * Publish the session's meeting point. The rules accept it only from the
   * holder of the lowest slot in its mask, so a denial is an answer about who
   * leads, not a failure of the database.
   */
  readonly writeMeeting: (
    code: string,
    meeting: PublishedMeeting,
    signal: AbortSignal,
  ) => Promise<Result<void, ResourceError>>;
  readonly placesEnabled: boolean;
}

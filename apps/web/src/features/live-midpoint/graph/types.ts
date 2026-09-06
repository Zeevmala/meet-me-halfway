import type * as GeoJSON from "geojson";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";

export type TravelProfile = "driving" | "walking";

export interface RouteInfo {
  geometry: GeoJSON.LineString;
  duration: number; // seconds
  distance: number; // meters
}

/** One participant as the session layer reports them. */
export interface ParticipantSource {
  readonly index: ParticipantIndex;
  readonly position: LatLng;
  readonly accuracy: number;
  readonly stale: boolean;
  readonly name: string | null;
}

/**
 * Participants as a structure of arrays, every array indexed by
 * `ParticipantIndex` and `MAX_PARTICIPANTS` long. A vacant slot is `null`.
 *
 * This is the "vectorized" shape that actually pays at N ≤ 5 — not typed
 * arrays or SIMD, where allocation would cost more than the arithmetic saves,
 * but a single pass producing parallel arrays with one agreed index space.
 * Routes, accuracy circles, marker colours and Mapbox layer ids all key off
 * the same `i`; they previously did not.
 */
export interface SlotVector {
  readonly positions: readonly (LatLng | null)[];
  readonly accuracy: readonly number[];
  readonly stale: readonly boolean[];
  readonly names: readonly (string | null)[];
  /** Slots actually taken, ascending — for iteration without scanning. */
  readonly occupied: readonly ParticipantIndex[];
  readonly ownSlot: ParticipantIndex | null;
}

/** Everything pushed into the graph from outside. */
export interface GraphSources {
  readonly ownSlot: ParticipantIndex | null;
  readonly ownPosition: LatLng | null;
  readonly ownAccuracy: number | null;
  readonly participants: readonly ParticipantSource[];
  readonly selectedVenueId: string | null;
  readonly travelProfile: TravelProfile;
}

export interface DestinationResult {
  readonly destination: LatLng | null;
  readonly selectedVenue: RankedVenue | null;
}

/**
 * View projections of the slot vector.
 *
 * They live beside the graph's own vocabulary rather than inside the
 * components that consume them, because both are read off the same slot index
 * space: whoever adds a field has to see that `index` here is the same `i`
 * that picks the colour, the Mapbox layer id and the route.
 */
export interface MapParticipant {
  readonly position: LatLng;
  readonly accuracy: number;
  readonly index: ParticipantIndex;
  readonly isOwn: boolean;
  readonly stale: boolean;
}

export interface OtherParticipantView {
  readonly index: ParticipantIndex;
  readonly route: RouteInfo | null;
  readonly position: LatLng;
  readonly stale: boolean;
  readonly name: string | null;
}

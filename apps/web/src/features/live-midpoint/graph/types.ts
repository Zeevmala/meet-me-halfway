import type * as GeoJSON from "geojson";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { RankedVenue } from "../lib/venue-ranking";

export type TravelProfile = "driving" | "walking";

/**
 * Routes as computed for one destination and travel profile.
 *
 * Tagged with what they answer so the graph can tell when they no longer do:
 * a route set for a previous venue, or kept after its participant left, used
 * to stay on the map and in the distances until something replaced it.
 */
export interface RouteSet {
  readonly dest: LatLng;
  readonly profile: TravelProfile;
  readonly bySlot: readonly (RouteInfo | null)[];
}

export interface RouteInfo {
  geometry: GeoJSON.LineString;
  duration: number; // seconds
  distance: number; // meters
}

/**
 * One participant as the session layer reports them.
 *
 * `lastSeen` rather than a pre-computed `stale` flag: staleness is
 * `now - lastSeen > threshold`, a predicate over a clock, and computing it in
 * the session layer meant it could only change when something *pushed* — which
 * is why it was driven by a 10s setInterval that mobile Safari throttles to
 * minutes and bfcache freezes outright. The graph derives it instead.
 */
export interface ParticipantSource {
  readonly index: ParticipantIndex;
  readonly position: LatLng;
  readonly accuracy: number;
  /** Server-clock epoch ms of this participant's most recent RTDB write. */
  readonly lastSeen: number;
  readonly name: string | null;
}

/**
 * Where the session lifecycle has got to. Distinct from the displayed
 * `SessionPhase`, which is derived: this is what the adapter knows (has the
 * handshake finished, did it fail), that is what the user sees (is anyone
 * else here, are they fresh).
 */
export type SessionStatus = "idle" | "connecting" | "ready" | "error";

/** What the UI renders. Derived — never stored. */
export type SessionPhase =
  "idle" | "creating" | "waiting" | "connected" | "some_stale" | "error";

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
  /** Silent long enough to have left — drawn, but no longer counted. */
  readonly departed: readonly boolean[];
  readonly names: readonly (string | null)[];
  /** Slots actually taken, ascending — for iteration without scanning. */
  readonly occupied: readonly ParticipantIndex[];
  /**
   * The occupied slots the midpoint and routes are computed from: everyone
   * but the departed. Own slot is always counted while it has a position.
   */
  readonly counted: readonly ParticipantIndex[];
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
  /** Session identity — the presence node writes under these. */
  readonly sessionCode: string | null;
  readonly ownUid: string | null;
  readonly ownName: string;
  readonly sessionStatus: SessionStatus;
  /**
   * Server clock minus this device's (`.info/serverTimeOffset`). Liveness
   * compares server-stamped `lastSeen` against server time, never against
   * this device's clock alone.
   */
  readonly serverTimeOffsetMs: number;
}

/**
 * Staleness and departure of every slot, plus the next instant either changes.
 *
 * `nextFlipAtMs` is what replaces the polling interval: the runtime arms a
 * single timer for that instant and nothing else. It is the same lazy-clock
 * argument `core/dag/breaker.ts` makes — a timestamp comparison survives a
 * backgrounded tab, a throttled timer and bfcache, where a repeating interval
 * does not.
 */
export interface LivenessResult {
  readonly stale: readonly boolean[];
  readonly departed: readonly boolean[];
  /**
   * Server-clock ms of the next transition, stale or departed; `null` once
   * everyone has departed.
   */
  readonly nextFlipAtMs: number | null;
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

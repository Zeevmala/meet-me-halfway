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
 * Where the session lifecycle has got to: what the adapter knows — is a
 * handshake running, did it succeed, is the listener still attached. Distinct
 * from the displayed `SessionPhase`, which is derived from this plus the
 * roster and the clock.
 *
 * One union, so that a code and a slot exist exactly when a session does. They
 * used to be three separate sources — code, slot and a four-value status —
 * and status `error` with a code and slot still set is what kept presence
 * publishing behind the error screen.
 *
 * The session hook's own state carries more (a handshake id, the failure);
 * it is assignable to this and is passed in as it is.
 */
export type SessionLifecycle =
  | { readonly kind: "idle" }
  | { readonly kind: "creating" }
  | { readonly kind: "joining" }
  | {
      readonly kind: "live";
      readonly code: string;
      readonly slot: ParticipantIndex;
      /** Server-clock ms at which `created` was stamped. */
      readonly createdAtMs: number;
    }
  | {
      /** The server cancelled the participants listener. */
      readonly kind: "lost";
      readonly code: string;
      readonly slot: ParticipantIndex;
      readonly createdAtMs: number;
    }
  | { readonly kind: "failed" }
  | { readonly kind: "closed" };

/** What the UI renders. Derived — never stored. */
export type SessionPhase =
  | "idle"
  | "creating"
  | "joining"
  | "waiting"
  | "connected"
  | "some_stale"
  | "lost"
  | "expired"
  | "failed"
  | "closed";

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
  /** The session, and with it the code and slot the presence node writes under. */
  readonly session: SessionLifecycle;
  readonly ownPosition: LatLng | null;
  readonly ownAccuracy: number | null;
  readonly participants: readonly ParticipantSource[];
  readonly selectedVenueId: string | null;
  readonly travelProfile: TravelProfile;
  readonly ownUid: string | null;
  readonly ownName: string;
  /**
   * Server clock minus this device's (`.info/serverTimeOffset`). Liveness and
   * expiry compare server-stamped times — `lastSeen`, `created` — against
   * server time, never against this device's clock alone.
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

/**
 * Whether the session has passed its 24 hours, and when it will if not.
 *
 * Derived from the server clock like liveness, and woken the same way: the
 * runtime arms one timer for `flipAtMs`. The rules refuse every write to an
 * expired session, and without this the presence node tried again every
 * three seconds, for as long as the page stayed open.
 */
export interface ExpiryResult {
  readonly expired: boolean;
  /** Server-clock ms of expiry; `null` once expired, or with no session. */
  readonly flipAtMs: number | null;
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
  /**
   * The letter on the marker, by the badge pill's rule (`participantInitial`),
   * so colour is not the only way to tell people apart. Null on the own
   * marker, which is marked as yours instead.
   */
  readonly label: string | null;
}

export interface OtherParticipantView {
  readonly index: ParticipantIndex;
  readonly route: RouteInfo | null;
  readonly position: LatLng;
  readonly stale: boolean;
  readonly name: string | null;
}

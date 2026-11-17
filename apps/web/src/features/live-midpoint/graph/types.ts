import type * as GeoJSON from "geojson";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { PlaceResult, RankedVenue } from "../lib/venue-ranking";

export type TravelProfile = "driving" | "walking";

/**
 * This device's own route, tagged with what it answers — the destination and
 * profile it was asked for — so the graph can tell when it no longer does.
 *
 * Each device routes only its own trip and publishes it for the others
 * (`PeerTrip`). Every device used to route everyone: five people meant
 * twenty-five requests to Mapbox for each move, each device sending all five
 * positions, against one rate limit that every device of every session
 * shares.
 */
export interface OwnRoute {
  readonly dest: LatLng;
  readonly profile: TravelProfile;
  /** `null` when there is no way there by this profile. */
  readonly route: RouteInfo | null;
}

/**
 * Another participant's trip, as their device published it
 * (`sessions/{code}/trips/{slot}`): to where, how, how long, and the line,
 * still encoded (`lib/polyline.ts`).
 */
export interface PeerTrip {
  readonly dest: LatLng;
  readonly profile: TravelProfile;
  /** Seconds. */
  readonly duration: number;
  /** Metres. */
  readonly distance: number;
  readonly line: string;
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

/**
 * The meeting point: the midpoint where it was when somebody first tapped
 * Navigate, fixed for everyone.
 *
 * The midpoint is live: it moves whenever anyone does, and it is gone the
 * moment the second-to-last person stops sharing — which is what tapping
 * Navigate does on a phone, as the page goes to the background. So a
 * destination the group had settled on drifted under them, and vanished for
 * whoever was left. A pin is the decision, kept. Nobody can move it: the
 * rules refuse a copy that disagrees with one already published.
 *
 * Every device publishes its copy in its own entry
 * (`sessions/{code}/meet/{slot}`), which is deleted with its position, so a
 * pin outlives any one person leaving and nothing of it outlives the session.
 */
export interface PinEvent {
  /** Server-clock ms at which it was set, as the setter's device knew it. */
  readonly at: number;
  /** The slot of whoever set it. */
  readonly by: ParticipantIndex;
  /**
   * Their display name as it was when they set it. Kept with the pin because
   * they are usually gone by the time anyone reads it, and their name went
   * with their entry.
   */
  readonly byName: string | null;
  readonly position: LatLng;
  /** The venue's name when it was set on one, else `null`. */
  readonly name: string | null;
}

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
  /**
   * The venue the user picked, as it was when they picked it. The place, not
   * an id to look up: the pick stays listed — pinned — and stays the
   * destination until it is cleared, even once a search no longer returns it.
   */
  readonly selectedPlace: PlaceResult | null;
  /**
   * The copies of the meeting point the database holds, this device's own
   * included: what the others have seen, kept by them as long as they are
   * here. They agree — the rules refuse one that does not.
   */
  readonly peerPins: readonly PinEvent[];
  /**
   * By slot: the trip each participant's device last published, `null` where
   * there is none. Own slot's entry is not read: own route is fetched here.
   */
  readonly peerTrips: readonly (PeerTrip | null)[];
  /** This device's travel mode; each person chooses their own. */
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
  /** The listed venue the destination is, if it is one. */
  readonly selectedVenue: RankedVenue | null;
}

/**
 * What the venue list can truthfully say. It was one `loading` flag, so it
 * said "No venues found" while the first search was still only scheduled,
 * blanked the list for a skeleton on every refresh, and said the same "No
 * venues found" when the search had failed.
 */
export type VenueStatus =
  /** No search is wanted: venue search is off, or there is no midpoint. */
  | "idle"
  /** A search is scheduled or out, and nothing has come back yet. */
  | "searching"
  /** An answer — a list, which may truthfully be empty. */
  | "ready"
  /** The search failed, with no earlier answer young enough to show. */
  | "failed";

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
  /** The travel mode their route is for: each person chooses their own. */
  readonly profile: TravelProfile | null;
  readonly position: LatLng;
  readonly stale: boolean;
  readonly name: string | null;
}

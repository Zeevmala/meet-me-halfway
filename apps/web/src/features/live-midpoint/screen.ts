import type { GeoStatus } from "./hooks/useLiveGeolocation";
import type { SessionFailure, SessionState } from "./hooks/useLiveSession";
import { sessionCode } from "./graph/nodes";
import type { SessionPhase } from "./graph/types";
import type { LatLng } from "./lib/geo-math";
import { MAX_PARTICIPANTS } from "./lib/participant-config";

/** What fills the sheet under the map. */
export type Sheet =
  | { readonly kind: "none" }
  /** The handshake has not reached the database: nothing to share yet. */
  | { readonly kind: "creating" }
  | { readonly kind: "joining" }
  /**
   * Live, and nobody else is counted. `full` when all five slots have been
   * claimed: the others can come back, but nobody new can join, so there is
   * nothing to share.
   */
  | { readonly kind: "waiting"; readonly code: string; readonly full: boolean }
  /** Others are here; this device's own position is what is missing. */
  | { readonly kind: "locating" }
  | {
      readonly kind: "meeting";
      readonly ownPosition: LatLng;
      readonly midpoint: LatLng;
    };

/** Location trouble that does not stop anything, drawn as a banner. */
export type LocationTrouble = "slow" | "unavailable";

/**
 * Everything the page can show, as one union. The page used to choose with
 * a chain of `if`s over GPS status, phase and position, each written for one
 * case. Between them they said "Waiting for others to join" to a phone whose
 * own GPS had no fix yet while the others were already there, and drew a GPS
 * timeout — the watch still acquiring — as a full-screen failure, whose Try
 * again tore that watch down.
 */
export type Screen =
  | { readonly kind: "ended"; readonly failure: SessionFailure }
  | { readonly kind: "locationDenied" }
  | { readonly kind: "locationUnsupported" }
  | {
      readonly kind: "map";
      /** The session code while there is one: the badge is drawn from it. */
      readonly code: string | null;
      readonly sheet: Sheet;
      readonly locationTrouble: LocationTrouble | null;
      /** A slot is free, so an invite can be accepted. */
      readonly canInvite: boolean;
      /**
       * Other devices that hold a slot and publish no position: joined and
       * still waiting for a fix, joined and gone, or joined to watch. A slot
       * is what lets a device read everyone's position, and nothing on the
       * map shows one that does not share its own — so the page says so.
       */
      readonly unseenDevices: number;
    };

export interface ScreenInputs {
  readonly phase: SessionPhase;
  readonly session: SessionState;
  readonly geo: GeoStatus;
  /** Own position as the slot vector holds it. */
  readonly ownPosition: LatLng | null;
  readonly midpoint: LatLng | null;
  readonly claimedSlots: number;
  /** Other participants with a position on the map; own is not counted. */
  readonly othersSharing: number;
}

const NO_SHEET: Sheet = { kind: "none" };

/**
 * Choose the screen. The precedence is the point:
 *
 * 1. A session that has ended. Nothing else on the page can help then: a
 *    location fixed for a session that has expired is of no use to anyone.
 * 2. Location denied or unsupported — the two states that stop sharing for
 *    good until the user acts.
 * 3. Otherwise the map. A slow or failing GPS is a banner on it, never a
 *    screen: the watch keeps acquiring, and the hook restarts it itself.
 */
export function deriveScreen(inputs: ScreenInputs): Screen {
  const failure = endedSession(inputs.phase, inputs.session);
  if (failure !== null) return { kind: "ended", failure };

  if (inputs.geo === "denied") return { kind: "locationDenied" };
  if (inputs.geo === "unsupported") return { kind: "locationUnsupported" };

  const code = sessionCode(inputs.session);
  // A claim is never released, so this is final once true.
  const full = inputs.claimedSlots >= MAX_PARTICIPANTS;
  return {
    kind: "map",
    code,
    sheet: deriveSheet(inputs, code, full),
    locationTrouble: locationTrouble(inputs.geo),
    canInvite: code !== null && !full,
    unseenDevices: unseenDevices(inputs, code),
  };
}

function deriveSheet(
  inputs: ScreenInputs,
  code: string | null,
  full: boolean,
): Sheet {
  switch (inputs.phase) {
    case "creating":
    case "joining":
      return { kind: inputs.phase };
    case "waiting":
      return code === null ? NO_SHEET : { kind: "waiting", code, full };
    case "connected":
    case "some_stale":
      if (code === null) return NO_SHEET;
      // Own slot and another make two points, so the midpoint exists
      // whenever own position does: a missing one is a missing own fix.
      return inputs.ownPosition !== null && inputs.midpoint !== null
        ? {
            kind: "meeting",
            ownPosition: inputs.ownPosition,
            midpoint: inputs.midpoint,
          }
        : { kind: "locating" };
    // `lost`, `expired` and `failed` reach here only in the render before the
    // graph takes the session that ended them; endedSession covers them from
    // the next one.
    case "idle":
    case "closed":
    case "lost":
    case "expired":
    case "failed":
      return NO_SHEET;
  }
}

/**
 * Claims, less this device's own, less the others who are on the map.
 *
 * Zero until the claims have been counted (`claimedSlots` is 0 until the
 * live session answers), and never negative: the two listeners it is fed by
 * do not arrive together.
 */
function unseenDevices(inputs: ScreenInputs, code: string | null): number {
  if (code === null) return 0;
  return Math.max(0, inputs.claimedSlots - 1 - inputs.othersSharing);
}

function locationTrouble(geo: GeoStatus): LocationTrouble | null {
  switch (geo) {
    case "timeout":
      return "slow";
    case "unavailable":
      return "unavailable";
    case "idle":
    case "requesting":
    case "watching":
    case "denied":
    case "unsupported":
      return null;
  }
}

/**
 * What the error panel says when the session has ended, or `null` while it
 * has not. The phase decides — expiry is the graph's, derived from the clock —
 * and the session supplies the details. Both have to agree: the graph takes
 * the session one render later, and in that render the page stays as it was
 * rather than guessing.
 */
export function endedSession(
  phase: SessionPhase,
  state: SessionState,
): SessionFailure | null {
  if (phase === "expired") return { code: "SESSION_EXPIRED", details: null };
  if (phase === "failed" && state.kind === "failed") {
    return { code: state.reason, details: state.details };
  }
  if (phase === "lost" && state.kind === "lost") {
    return { code: "CONNECTION_ERROR", details: state.details };
  }
  return null;
}

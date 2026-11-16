import { describe, expect, it } from "vitest";
import { deriveScreen, endedSession } from "./screen";
import type { ScreenInputs } from "./screen";
import type { SessionState } from "./hooks/useLiveSession";
import type { LatLng } from "./lib/geo-math";

const CODE = "K7M2QX";
const LIVE: SessionState = {
  kind: "live",
  code: CODE,
  slot: 1,
  createdAtMs: 1_000,
};
const LOST: SessionState = {
  ...LIVE,
  kind: "lost",
  details: "permission_denied",
};
const OWN: LatLng = { lat: 32.08, lng: 34.78 };
const MIDPOINT: LatLng = { lat: 32.0, lng: 34.9 };

function inputs(overrides: Partial<ScreenInputs> = {}): ScreenInputs {
  return {
    phase: "connected",
    session: LIVE,
    geo: "watching",
    ownPosition: OWN,
    midpoint: MIDPOINT,
    claimedSlots: 2,
    ...overrides,
  };
}

describe("deriveScreen — precedence", () => {
  // Fixing location cannot help a session that is over, so the session's
  // end is what the screen says.
  it("an ended session wins over a denied location", () => {
    expect(deriveScreen(inputs({ phase: "expired", geo: "denied" }))).toEqual({
      kind: "ended",
      failure: { code: "SESSION_EXPIRED", details: null },
    });
  });

  it("a failed handshake ends the page with its reason", () => {
    const failed: SessionState = {
      kind: "failed",
      reason: "SESSION_FULL",
      details: null,
    };
    expect(
      deriveScreen(
        inputs({ phase: "failed", session: failed, geo: "unsupported" }),
      ),
    ).toEqual({
      kind: "ended",
      failure: { code: "SESSION_FULL", details: null },
    });
  });

  it("a lost session ends the page as a connection error, with details", () => {
    expect(deriveScreen(inputs({ phase: "lost", session: LOST }))).toEqual({
      kind: "ended",
      failure: { code: "CONNECTION_ERROR", details: "permission_denied" },
    });
  });

  it("a denied location replaces the map in every live phase", () => {
    for (const phase of ["creating", "waiting", "connected"] as const) {
      expect(deriveScreen(inputs({ phase, geo: "denied" }))).toEqual({
        kind: "locationDenied",
      });
    }
  });

  it("a browser without geolocation has its own screen", () => {
    expect(deriveScreen(inputs({ geo: "unsupported" }))).toEqual({
      kind: "locationUnsupported",
    });
  });
});

describe("deriveScreen — the sheet", () => {
  it("is the handshake while creating or joining, with nothing to invite to", () => {
    for (const phase of ["creating", "joining"] as const) {
      const screen = deriveScreen(
        inputs({
          phase,
          session: { kind: phase, handshake: 1 },
          ownPosition: null,
          midpoint: null,
          claimedSlots: 0,
        }),
      );
      expect(screen).toMatchObject({
        kind: "map",
        code: null,
        sheet: { kind: phase },
        canInvite: false,
      });
    }
  });

  it("waits with the code to share while alone and a slot is free", () => {
    const screen = deriveScreen(
      inputs({ phase: "waiting", midpoint: null, claimedSlots: 3 }),
    );
    expect(screen).toEqual({
      kind: "map",
      code: CODE,
      sheet: { kind: "waiting", code: CODE, full: false },
      locationTrouble: null,
      canInvite: true,
    });
  });

  // Two people present out of five claims used to read as three free
  // places: invites went out to a session nobody else could join.
  it("waits without inviting once all five slots are claimed, however few are present", () => {
    const screen = deriveScreen(
      inputs({ phase: "waiting", midpoint: null, claimedSlots: 5 }),
    );
    expect(screen).toMatchObject({
      sheet: { kind: "waiting", code: CODE, full: true },
      canInvite: false,
    });
  });

  // The regression: the others were on the map, and the sheet said
  // "Waiting for others to join" because this phone had no fix yet.
  it("says it is locating, not waiting, when others are here and own position is not", () => {
    for (const phase of ["connected", "some_stale"] as const) {
      expect(
        deriveScreen(inputs({ phase, ownPosition: null, midpoint: null })),
      ).toMatchObject({ kind: "map", sheet: { kind: "locating" } });
    }
  });

  it("is the meeting once own position and the midpoint are both known", () => {
    expect(deriveScreen(inputs({ phase: "some_stale" }))).toMatchObject({
      sheet: { kind: "meeting", ownPosition: OWN, midpoint: MIDPOINT },
      canInvite: true,
    });
  });

  it("keeps the meeting in a full session, without the invite", () => {
    expect(deriveScreen(inputs({ claimedSlots: 5 }))).toMatchObject({
      sheet: { kind: "meeting" },
      canInvite: false,
    });
  });

  it("is empty before the handshake starts and once the page is closing", () => {
    expect(
      deriveScreen(inputs({ phase: "idle", session: { kind: "idle" } })),
    ).toMatchObject({ kind: "map", sheet: { kind: "none" }, code: null });
    expect(
      deriveScreen(inputs({ phase: "closed", session: { kind: "closed" } })),
    ).toMatchObject({ kind: "map", sheet: { kind: "none" }, code: null });
  });

  // The graph takes the session one render after the page does. In that
  // render the page stays as it was rather than guessing.
  it("stays as it was in the render before the graph takes an ended session", () => {
    expect(deriveScreen(inputs({ session: LOST }))).toMatchObject({
      kind: "map",
      code: CODE,
      sheet: { kind: "meeting" },
    });
  });
});

describe("deriveScreen — location trouble", () => {
  // The regression: a timeout was a full-screen failure, and its Try again
  // tore down the watch that was still acquiring.
  it("draws a timeout as a banner over the map, leaving the sheet as it is", () => {
    const screen = deriveScreen(
      inputs({ geo: "timeout", ownPosition: null, midpoint: null }),
    );
    expect(screen).toMatchObject({
      kind: "map",
      locationTrouble: "slow",
      sheet: { kind: "locating" },
    });
  });

  it("draws a position the device cannot provide as a banner too", () => {
    const screen = deriveScreen(
      inputs({ phase: "waiting", geo: "unavailable", ownPosition: null }),
    );
    expect(screen).toMatchObject({
      kind: "map",
      locationTrouble: "unavailable",
      sheet: { kind: "waiting", full: false },
    });
  });

  it("has no banner while the location is coming or working", () => {
    for (const geo of ["idle", "requesting", "watching"] as const) {
      expect(deriveScreen(inputs({ geo }))).toMatchObject({
        locationTrouble: null,
      });
    }
  });
});

describe("endedSession", () => {
  it("is null while the session has not ended", () => {
    expect(endedSession("connected", LIVE)).toBeNull();
    expect(endedSession("closed", { kind: "closed" })).toBeNull();
  });

  it("needs the phase and the session to agree", () => {
    expect(endedSession("lost", LIVE)).toBeNull();
    expect(endedSession("connected", LOST)).toBeNull();
  });
});

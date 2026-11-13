import { describe, it, expect } from "vitest";
import {
  buildSlotVector,
  deriveExpiry,
  deriveLiveness,
  deriveMidpoint,
  deriveDestination,
  derivePhase,
  sessionCode,
  sessionSlot,
  DEPARTED_THRESHOLD_MS,
  SESSION_TTL_MS,
  STALE_THRESHOLD_MS,
} from "./nodes";
import type {
  ExpiryResult,
  GraphSources,
  LivenessResult,
  ParticipantSource,
  SessionLifecycle,
} from "./types";
import type { LatLng } from "../lib/geo-math";
import type { RankedVenue } from "../lib/venue-ranking";
import type { ParticipantIndex } from "../lib/participant-config";
import { MAX_PARTICIPANTS } from "../lib/participant-config";

const NOW = 1_000_000;

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };
const HAIFA: LatLng = { lat: 32.794, lng: 34.99 };

function participant(
  index: 0 | 1 | 2 | 3 | 4,
  position: LatLng,
  overrides: Partial<ParticipantSource> = {},
): ParticipantSource {
  return {
    index,
    position,
    accuracy: 10,
    lastSeen: NOW,
    name: null,
    ...overrides,
  };
}

const NONE = () => new Array<boolean>(MAX_PARTICIPANTS).fill(false);

/** Liveness with nobody stale — the default for slot-vector tests. */
function fresh(): LivenessResult {
  return { stale: NONE(), departed: NONE(), nextFlipAtMs: null };
}

const IDLE: SessionLifecycle = { kind: "idle" };

/** A live session holding `slot`, created at `createdAtMs` (server time). */
function live(slot: ParticipantIndex = 0, createdAtMs = NOW): SessionLifecycle {
  return { kind: "live", code: "ABC123", slot, createdAtMs };
}

function sources(overrides: Partial<GraphSources> = {}): GraphSources {
  return {
    session: live(0),
    ownPosition: TEL_AVIV,
    ownAccuracy: 5,
    participants: [],
    selectedVenueId: null,
    travelProfile: "driving",
    ownUid: "own-uid",
    ownName: "Me",
    serverTimeOffsetMs: 0,
    ...overrides,
  };
}

function venue(id: string, location: LatLng): RankedVenue {
  return {
    id,
    displayName: `Venue ${id}`,
    location,
    rating: 4,
    userRatingCount: 10,
    openNow: true,
    types: ["cafe"],
    score: 1,
  };
}

describe("buildSlotVector", () => {
  it("produces fixed-length arrays with vacant slots as null", () => {
    const v = buildSlotVector(sources(), fresh());

    expect(v.positions).toHaveLength(MAX_PARTICIPANTS);
    expect(v.positions[0]).toEqual(TEL_AVIV);
    expect(v.positions[1]).toBeNull();
    expect(v.occupied).toEqual([0]);
    expect(v.ownSlot).toBe(0);
  });

  it("places each participant at their own slot, not their array position", () => {
    const v = buildSlotVector(
      sources({
        session: live(2),
        ownPosition: HAIFA,
        participants: [participant(0, TEL_AVIV), participant(4, JERUSALEM)],
      }),
      fresh(),
    );

    expect(v.positions[0]).toEqual(TEL_AVIV);
    expect(v.positions[2]).toEqual(HAIFA);
    expect(v.positions[4]).toEqual(JERUSALEM);
    expect(v.positions[1]).toBeNull();
    expect(v.positions[3]).toBeNull();
    expect(v.occupied).toEqual([0, 2, 4]);
  });

  it("leaves slot 0 vacant when the creator has left", () => {
    const v = buildSlotVector(
      sources({
        session: live(1),
        ownPosition: TEL_AVIV,
        participants: [participant(3, JERUSALEM)],
      }),
      fresh(),
    );

    expect(v.positions[0]).toBeNull();
    expect(v.occupied).toEqual([1, 3]);
  });

  it("takes staleness from liveness, not from the participant record", () => {
    const stale = new Array<boolean>(MAX_PARTICIPANTS).fill(false);
    stale[1] = true;
    const v = buildSlotVector(
      sources({ participants: [participant(1, JERUSALEM)] }),
      { stale, departed: NONE(), nextFlipAtMs: null },
    );

    expect(v.stale[1]).toBe(true);
    expect(v.stale[0]).toBe(false);
  });

  it("carries accuracy and names alongside positions", () => {
    const v = buildSlotVector(
      sources({
        participants: [
          participant(1, JERUSALEM, { accuracy: 42, name: "Dana" }),
        ],
      }),
      fresh(),
    );

    expect(v.accuracy[1]).toBe(42);
    expect(v.names[1]).toBe("Dana");
    // Own slot defaults are not contaminated by the participant's.
    expect(v.accuracy[0]).toBe(5);
  });

  it("omits own position while its slot is still unknown", () => {
    const v = buildSlotVector(sources({ session: IDLE }), fresh());

    expect(v.occupied).toEqual([]);
    expect(v.ownSlot).toBeNull();
  });

  it("still draws a departed peer, but stops counting them", () => {
    const departed = NONE();
    departed[1] = true;
    const v = buildSlotVector(
      sources({
        participants: [participant(1, JERUSALEM), participant(2, HAIFA)],
      }),
      { stale: departed, departed, nextFlipAtMs: null },
    );

    expect(v.positions[1]).toEqual(JERUSALEM);
    expect(v.occupied).toEqual([0, 1, 2]);
    expect(v.counted).toEqual([0, 2]);
    expect(v.departed[1]).toBe(true);
  });

  it("always counts own slot", () => {
    // Own position is this device's GPS fix. The session layer drops our own
    // record, so liveness never judges it; should it ever, how long ago our
    // last write landed says nothing about whether we are still here.
    const departed = NONE();
    departed[0] = true;
    const v = buildSlotVector(sources(), {
      stale: departed,
      departed,
      nextFlipAtMs: null,
    });

    expect(v.counted).toEqual([0]);
  });
});

describe("deriveMidpoint", () => {
  it("returns null with fewer than two participants", () => {
    expect(deriveMidpoint(buildSlotVector(sources(), fresh()))).toBeNull();
    expect(
      deriveMidpoint(buildSlotVector(sources({ ownPosition: null }), fresh())),
    ).toBeNull();
  });

  it("returns a centroid between two participants", () => {
    const midpoint = deriveMidpoint(
      buildSlotVector(
        sources({ participants: [participant(1, JERUSALEM)] }),
        fresh(),
      ),
    );

    expect(midpoint).not.toBeNull();
    expect(midpoint?.lat).toBeGreaterThan(31.77);
    expect(midpoint?.lat).toBeLessThan(32.08);
    expect(midpoint?.lng).toBeGreaterThan(34.78);
    expect(midpoint?.lng).toBeLessThan(35.21);
  });

  it("is unaffected by which slots are occupied", () => {
    const dense = deriveMidpoint(
      buildSlotVector(
        sources({ participants: [participant(1, JERUSALEM)] }),
        fresh(),
      ),
    );
    const sparse = deriveMidpoint(
      buildSlotVector(
        sources({
          session: live(2),
          participants: [participant(4, JERUSALEM)],
        }),
        fresh(),
      ),
    );

    expect(sparse?.lat).toBeCloseTo(dense?.lat ?? NaN, 10);
    expect(sparse?.lng).toBeCloseTo(dense?.lng ?? NaN, 10);
  });

  // A peer silent for minutes kept pulling the midpoint towards wherever they
  // were last seen, for as long as their node stayed in the database.
  it("leaves a departed participant out", () => {
    const departed = NONE();
    departed[2] = true;
    const withDeparted = deriveMidpoint(
      buildSlotVector(
        sources({
          participants: [participant(1, JERUSALEM), participant(2, HAIFA)],
        }),
        { stale: departed, departed, nextFlipAtMs: null },
      ),
    );
    const withoutThem = deriveMidpoint(
      buildSlotVector(
        sources({ participants: [participant(1, JERUSALEM)] }),
        fresh(),
      ),
    );

    expect(withDeparted?.lat).toBeCloseTo(withoutThem?.lat ?? NaN, 10);
    expect(withDeparted?.lng).toBeCloseTo(withoutThem?.lng ?? NaN, 10);
  });

  it("has no midpoint once the only peer has departed", () => {
    const departed = NONE();
    departed[1] = true;
    const v = buildSlotVector(
      sources({ participants: [participant(1, JERUSALEM)] }),
      { stale: departed, departed, nextFlipAtMs: null },
    );

    expect(deriveMidpoint(v)).toBeNull();
  });
});

describe("deriveDestination", () => {
  it("uses the midpoint when nothing is selected", () => {
    const result = deriveDestination([], null, TEL_AVIV);

    expect(result.destination).toEqual(TEL_AVIV);
    expect(result.selectedVenue).toBeNull();
  });

  it("uses the selected venue's location when it is present", () => {
    const v = venue("v1", JERUSALEM);
    const result = deriveDestination([v], "v1", TEL_AVIV);

    expect(result.destination).toEqual(JERUSALEM);
    expect(result.selectedVenue).toBe(v);
  });

  // Regression: reconciliation used to be an effect that only ran when
  // venues.length > 0, so a search returning no results left a venue that no
  // longer existed pinned as the destination indefinitely.
  it("releases a selection when the venue list comes back empty", () => {
    const result = deriveDestination([], "v1", TEL_AVIV);

    expect(result.destination).toEqual(TEL_AVIV);
    expect(result.selectedVenue).toBeNull();
  });

  it("releases a selection that disappeared from a refreshed list", () => {
    const result = deriveDestination([venue("v2", HAIFA)], "v1", TEL_AVIV);

    expect(result.destination).toEqual(TEL_AVIV);
    expect(result.selectedVenue).toBeNull();
  });

  it("returns no destination when there is neither a venue nor a midpoint", () => {
    expect(deriveDestination([], "v1", null).destination).toBeNull();
  });
});

describe("deriveLiveness", () => {
  it("marks nobody stale when every write is recent", () => {
    const result = deriveLiveness(
      [participant(1, JERUSALEM), participant(2, HAIFA)],
      NOW,
    );

    expect(result.stale.some(Boolean)).toBe(false);
  });

  it("marks a participant stale once their write ages past the threshold", () => {
    const result = deriveLiveness(
      [participant(1, JERUSALEM, { lastSeen: NOW - STALE_THRESHOLD_MS - 1 })],
      NOW,
    );

    expect(result.stale[1]).toBe(true);
  });

  it("is stale exactly at the threshold, and next waits for departure", () => {
    // The boundary is inclusive because the runtime arms a wake for precisely
    // this instant: if the predicate were still false when that wake fired,
    // it would re-derive the same target and re-arm at a zero delay forever.
    const lastSeen = NOW - STALE_THRESHOLD_MS;
    const result = deriveLiveness(
      [participant(1, JERUSALEM, { lastSeen })],
      NOW,
    );

    expect(result.stale[1]).toBe(true);
    expect(result.departed[1]).toBe(false);
    expect(result.nextFlipAtMs).toBe(lastSeen + DEPARTED_THRESHOLD_MS);
  });

  it("marks a participant departed exactly at the departure threshold", () => {
    const before = deriveLiveness(
      [
        participant(1, JERUSALEM, {
          lastSeen: NOW - DEPARTED_THRESHOLD_MS + 1,
        }),
      ],
      NOW,
    );
    const at = deriveLiveness(
      [participant(1, JERUSALEM, { lastSeen: NOW - DEPARTED_THRESHOLD_MS })],
      NOW,
    );

    expect(before.departed[1]).toBe(false);
    expect(before.nextFlipAtMs).toBe(NOW + 1);
    expect(at.departed[1]).toBe(true);
    expect(at.stale[1]).toBe(true);
  });

  it("is fresh one millisecond before the threshold", () => {
    const result = deriveLiveness(
      [participant(1, JERUSALEM, { lastSeen: NOW - STALE_THRESHOLD_MS + 1 })],
      NOW,
    );

    expect(result.stale[1]).toBe(false);
    expect(result.nextFlipAtMs).toBe(NOW + 1);
  });

  it("reports the earliest instant at which staleness changes", () => {
    // The wake target: the runtime arms one timer for this and nothing else.
    const result = deriveLiveness(
      [
        participant(1, JERUSALEM, { lastSeen: NOW - 20_000 }),
        participant(2, HAIFA, { lastSeen: NOW - 5_000 }),
      ],
      NOW,
    );

    expect(result.nextFlipAtMs).toBe(NOW - 20_000 + STALE_THRESHOLD_MS);
  });

  it("has no next flip once everyone has departed", () => {
    const result = deriveLiveness(
      [participant(1, JERUSALEM, { lastSeen: NOW - DEPARTED_THRESHOLD_MS })],
      NOW,
    );

    expect(result.departed[1]).toBe(true);
    expect(result.nextFlipAtMs).toBeNull();
  });

  it("waits for the earliest transition across stale and departed peers", () => {
    const result = deriveLiveness(
      [
        // Stale already; departs 100s from now.
        participant(1, JERUSALEM, {
          lastSeen: NOW - 20_000 - STALE_THRESHOLD_MS,
        }),
        // Fresh; goes stale 25s from now.
        participant(2, HAIFA, { lastSeen: NOW - 5_000 }),
      ],
      NOW,
    );

    expect(result.nextFlipAtMs).toBe(NOW - 5_000 + STALE_THRESHOLD_MS);
  });

  it("has no next flip with an empty roster", () => {
    expect(deriveLiveness([], NOW).nextFlipAtMs).toBeNull();
  });

  it("reports the truth after a long background gap, not a missed tick", () => {
    // A repeating interval is throttled to minutes on mobile and frozen under
    // bfcache, so a tab resumed after ten minutes had a stale answer until the
    // next tick. Recomputing from the clock has no such window.
    const roster = [participant(1, JERUSALEM, { lastSeen: NOW })];

    expect(deriveLiveness(roster, NOW).stale[1]).toBe(false);
    expect(deriveLiveness(roster, NOW + 10 * 60_000).stale[1]).toBe(true);
  });

  it("ignores an out-of-range slot rather than writing past the vector", () => {
    // Deliberately outside ParticipantIndex — the point of the test is that
    // the node rejects it rather than writing past the vector. `as unknown`
    // because 9 is not comparable to the union, which is exactly the invariant
    // being probed.
    const rogue = {
      ...participant(1, JERUSALEM),
      index: 9,
    } as unknown as ParticipantSource;
    const result = deriveLiveness([rogue], NOW);

    expect(result.stale).toHaveLength(MAX_PARTICIPANTS);
    expect(result.stale.some(Boolean)).toBe(false);
  });
});

describe("derivePhase", () => {
  const solo = () => buildSlotVector(sources(), fresh());
  const withPeer = (stale: boolean) => {
    const flags = new Array<boolean>(MAX_PARTICIPANTS).fill(false);
    flags[1] = stale;
    const liveness: LivenessResult = {
      stale: flags,
      departed: NONE(),
      nextFlipAtMs: null,
    };
    return {
      slots: buildSlotVector(
        sources({ participants: [participant(1, JERUSALEM)] }),
        liveness,
      ),
      liveness,
    };
  };

  const OPEN: ExpiryResult = { expired: false, flipAtMs: NOW + 1 };
  const EXPIRED: ExpiryResult = { expired: true, flipAtMs: null };
  const lost: SessionLifecycle = {
    kind: "lost",
    code: "ABC123",
    slot: 0,
    createdAtMs: NOW,
  };

  it("maps the lifecycle's own states straight through", () => {
    for (const kind of [
      "idle",
      "creating",
      "joining",
      "failed",
      "closed",
    ] as const) {
      expect(derivePhase({ kind }, OPEN, solo(), fresh())).toBe(kind);
    }
  });

  it("reports a failure even once peers are present", () => {
    const { slots, liveness } = withPeer(false);
    expect(derivePhase({ kind: "failed" }, OPEN, slots, liveness)).toBe(
      "failed",
    );
  });

  it("reports a lost listener, peers or not", () => {
    const { slots, liveness } = withPeer(false);
    expect(derivePhase(lost, OPEN, slots, liveness)).toBe("lost");
  });

  // Expiry is the truer reason: a listener the server cancelled at the end of
  // the 24 hours is a session that expired, not a connection problem.
  it("reports expiry over a live or lost session", () => {
    const { slots, liveness } = withPeer(false);
    expect(derivePhase(live(), EXPIRED, slots, liveness)).toBe("expired");
    expect(derivePhase(lost, EXPIRED, slots, liveness)).toBe("expired");
  });

  it("waits while nobody else has reported a position", () => {
    expect(derivePhase(live(), OPEN, solo(), fresh())).toBe("waiting");
  });

  it("connects once a fresh peer is present", () => {
    const { slots, liveness } = withPeer(false);
    expect(derivePhase(live(), OPEN, slots, liveness)).toBe("connected");
  });

  it("reports some_stale when a peer has gone quiet", () => {
    const { slots, liveness } = withPeer(true);
    expect(derivePhase(live(), OPEN, slots, liveness)).toBe("some_stale");
  });

  it("waits again once the only peer has departed", () => {
    const flags = NONE();
    flags[1] = true;
    const liveness: LivenessResult = {
      stale: flags,
      departed: flags,
      nextFlipAtMs: null,
    };
    const slots = buildSlotVector(
      sources({ participants: [participant(1, JERUSALEM)] }),
      liveness,
    );

    expect(derivePhase(live(), OPEN, slots, liveness)).toBe("waiting");
  });

  it("does not count own slot as a peer", () => {
    // Own staleness is not a thing the user needs telling about, and counting
    // it would flip a solo session to "connected" against itself.
    const flags = new Array<boolean>(MAX_PARTICIPANTS).fill(true);
    const liveness: LivenessResult = {
      stale: flags,
      departed: NONE(),
      nextFlipAtMs: null,
    };
    expect(
      derivePhase(live(), OPEN, buildSlotVector(sources(), liveness), liveness),
    ).toBe("waiting");
  });
});

describe("deriveExpiry", () => {
  it("expires exactly 24 hours after `created`, server time", () => {
    const session = live(0, NOW);

    expect(deriveExpiry(session, NOW + SESSION_TTL_MS - 1)).toEqual({
      expired: false,
      flipAtMs: NOW + SESSION_TTL_MS,
    });
    // Inclusive, as liveness is: the wake fires at exactly `flipAtMs`, and
    // the predicate must be true when it does or the wake re-arms at zero.
    expect(deriveExpiry(session, NOW + SESSION_TTL_MS)).toEqual({
      expired: true,
      flipAtMs: null,
    });
  });

  it("still expires a session whose listener was lost", () => {
    const lost: SessionLifecycle = {
      kind: "lost",
      code: "ABC123",
      slot: 1,
      createdAtMs: NOW,
    };
    expect(deriveExpiry(lost, NOW + SESSION_TTL_MS).expired).toBe(true);
  });

  it("has nothing to expire, and nothing to wake for, without a session", () => {
    for (const kind of [
      "idle",
      "creating",
      "joining",
      "failed",
      "closed",
    ] as const) {
      expect(deriveExpiry({ kind }, NOW + 10 * SESSION_TTL_MS)).toEqual({
        expired: false,
        flipAtMs: null,
      });
    }
  });
});

describe("sessionCode / sessionSlot", () => {
  it("exist exactly while the session does: live or lost", () => {
    expect(sessionCode(live(3))).toBe("ABC123");
    expect(sessionSlot(live(3))).toBe(3);
    const lost: SessionLifecycle = {
      kind: "lost",
      code: "XYZ789",
      slot: 2,
      createdAtMs: NOW,
    };
    expect(sessionCode(lost)).toBe("XYZ789");
    expect(sessionSlot(lost)).toBe(2);
    for (const kind of ["idle", "joining", "failed", "closed"] as const) {
      expect(sessionCode({ kind })).toBeNull();
      expect(sessionSlot({ kind })).toBeNull();
    }
  });
});

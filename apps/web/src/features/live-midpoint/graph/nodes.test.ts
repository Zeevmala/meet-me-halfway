import { describe, it, expect } from "vitest";
import { buildSlotVector, deriveMidpoint, deriveDestination } from "./nodes";
import type { GraphSources, ParticipantSource } from "./types";
import type { LatLng } from "../lib/geo-math";
import type { RankedVenue } from "../lib/venue-ranking";
import { MAX_PARTICIPANTS } from "../lib/participant-config";

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
    stale: false,
    name: null,
    ...overrides,
  };
}

function sources(overrides: Partial<GraphSources> = {}): GraphSources {
  return {
    ownSlot: 0,
    ownPosition: TEL_AVIV,
    ownAccuracy: 5,
    participants: [],
    selectedVenueId: null,
    travelProfile: "driving",
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
    const v = buildSlotVector(sources());

    expect(v.positions).toHaveLength(MAX_PARTICIPANTS);
    expect(v.positions[0]).toEqual(TEL_AVIV);
    expect(v.positions[1]).toBeNull();
    expect(v.occupied).toEqual([0]);
    expect(v.ownSlot).toBe(0);
  });

  it("places each participant at their own slot, not their array position", () => {
    const v = buildSlotVector(
      sources({
        ownSlot: 2,
        ownPosition: HAIFA,
        participants: [participant(0, TEL_AVIV), participant(4, JERUSALEM)],
      }),
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
        ownSlot: 1,
        ownPosition: TEL_AVIV,
        participants: [participant(3, JERUSALEM)],
      }),
    );

    expect(v.positions[0]).toBeNull();
    expect(v.occupied).toEqual([1, 3]);
  });

  it("carries accuracy, staleness and names alongside positions", () => {
    const v = buildSlotVector(
      sources({
        participants: [
          participant(1, JERUSALEM, {
            accuracy: 42,
            stale: true,
            name: "Dana",
          }),
        ],
      }),
    );

    expect(v.accuracy[1]).toBe(42);
    expect(v.stale[1]).toBe(true);
    expect(v.names[1]).toBe("Dana");
    // Own slot defaults are not contaminated by the participant's.
    expect(v.stale[0]).toBe(false);
    expect(v.accuracy[0]).toBe(5);
  });

  it("omits own position while its slot is still unknown", () => {
    const v = buildSlotVector(sources({ ownSlot: null }));

    expect(v.occupied).toEqual([]);
    expect(v.ownSlot).toBeNull();
  });
});

describe("deriveMidpoint", () => {
  it("returns null with fewer than two participants", () => {
    expect(deriveMidpoint(buildSlotVector(sources()))).toBeNull();
    expect(
      deriveMidpoint(buildSlotVector(sources({ ownPosition: null }))),
    ).toBeNull();
  });

  it("returns a centroid between two participants", () => {
    const midpoint = deriveMidpoint(
      buildSlotVector(sources({ participants: [participant(1, JERUSALEM)] })),
    );

    expect(midpoint).not.toBeNull();
    expect(midpoint?.lat).toBeGreaterThan(31.77);
    expect(midpoint?.lat).toBeLessThan(32.08);
    expect(midpoint?.lng).toBeGreaterThan(34.78);
    expect(midpoint?.lng).toBeLessThan(35.21);
  });

  it("is unaffected by which slots are occupied", () => {
    const dense = deriveMidpoint(
      buildSlotVector(sources({ participants: [participant(1, JERUSALEM)] })),
    );
    const sparse = deriveMidpoint(
      buildSlotVector(
        sources({ ownSlot: 2, participants: [participant(4, JERUSALEM)] }),
      ),
    );

    expect(sparse?.lat).toBeCloseTo(dense?.lat ?? NaN, 10);
    expect(sparse?.lng).toBeCloseTo(dense?.lng ?? NaN, 10);
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

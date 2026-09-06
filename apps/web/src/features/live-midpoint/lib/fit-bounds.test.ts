import { describe, it, expect } from "vitest";
import { fitSignature, hasSettled } from "./fit-bounds";
import type { MapParticipant } from "../graph/types";
import type { RankedVenue } from "./venue-ranking";
import type { ParticipantIndex } from "./participant-config";

const TLV = { lat: 32.0853, lng: 34.7818 };

function participant(
  index: ParticipantIndex,
  lat: number,
  lng: number,
): MapParticipant {
  return {
    index,
    position: { lat, lng },
    accuracy: 10,
    isOwn: index === 0,
    stale: false,
  };
}

function venue(id: string, lat: number, lng: number): RankedVenue {
  return {
    id,
    displayName: id,
    location: { lat, lng },
    rating: 4,
    userRatingCount: 100,
    openNow: true,
    types: ["cafe"],
    score: 1,
    distanceMeters: 0,
  } as RankedVenue;
}

/** ~1 metre at this latitude; well inside any sane threshold. */
const ONE_METRE_LAT = 1 / 111_320;

describe("fitSignature", () => {
  it("keys each point by identity, not position", () => {
    const signature = fitSignature(
      [participant(0, TLV.lat, TLV.lng), participant(3, 32.09, 34.79)],
      TLV,
      venue("v1", 32.07, 34.77),
    );

    expect([...signature.keys()].sort()).toEqual([
      "midpoint",
      "slot:0",
      "slot:3",
      "venue:v1",
    ]);
  });

  it("omits absent midpoint and venue", () => {
    const signature = fitSignature(
      [participant(0, TLV.lat, TLV.lng)],
      null,
      null,
    );
    expect([...signature.keys()]).toEqual(["slot:0"]);
  });
});

describe("hasSettled", () => {
  it("settles when the same entities barely moved", () => {
    const before = fitSignature([participant(0, TLV.lat, TLV.lng)], TLV, null);
    const after = fitSignature(
      [participant(0, TLV.lat + ONE_METRE_LAT, TLV.lng)],
      TLV,
      null,
    );
    expect(hasSettled(before, after, 50)).toBe(true);
  });

  it("does not settle when an entity moved past the threshold", () => {
    const before = fitSignature([participant(0, TLV.lat, TLV.lng)], null, null);
    const after = fitSignature(
      [participant(0, TLV.lat + ONE_METRE_LAT * 100, TLV.lng)],
      null,
      null,
    );
    expect(hasSettled(before, after, 50)).toBe(false);
  });

  it("refits when a joiner replaces a deselected venue", () => {
    // The regression: both sets have two entries, so a length check passes and
    // a positional walk compared slot 1's position against the old venue's.
    // Slot 1 sits within the threshold of where the venue was, so the
    // positional guard suppressed a refit that has to happen.
    const before = fitSignature(
      [participant(0, TLV.lat, TLV.lng)],
      null,
      venue("v1", 32.09, 34.79),
    );
    const after = fitSignature(
      [participant(0, TLV.lat, TLV.lng), participant(1, 32.09, 34.79)],
      null,
      null,
    );

    expect(before.size).toBe(after.size);
    expect(hasSettled(before, after, 50)).toBe(false);
  });

  it("refits when the selected venue changes to another at the same spot", () => {
    const before = fitSignature([], null, venue("v1", 32.09, 34.79));
    const after = fitSignature([], null, venue("v2", 32.09, 34.79));
    expect(hasSettled(before, after, 50)).toBe(false);
  });

  it("refits when a participant leaves", () => {
    const before = fitSignature(
      [participant(0, TLV.lat, TLV.lng), participant(1, 32.09, 34.79)],
      null,
      null,
    );
    const after = fitSignature([participant(0, TLV.lat, TLV.lng)], null, null);
    expect(hasSettled(before, after, 50)).toBe(false);
  });

  it("refits from an empty previous signature", () => {
    const after = fitSignature([participant(0, TLV.lat, TLV.lng)], null, null);
    expect(hasSettled(new Map(), after, 50)).toBe(false);
  });
});

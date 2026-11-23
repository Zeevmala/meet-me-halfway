import { describe, it, expect } from "vitest";
import {
  CANDIDATES_PER_ROUND,
  acceptsMeeting,
  keepsIncumbent,
  occupancyMask,
  pickFairest,
  ringCandidates,
  scoreCandidates,
  spreadRadius,
} from "./fair-point";
import type { ScoredCandidate } from "./fair-point";
import { haversineDistance } from "./geo-math";
import type { LatLng } from "./geo-math";
import { MATRIX_MAX_COORDINATES } from "./matrix-api";
import { MAX_PARTICIPANTS } from "./participant-config";

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };
const CENTRE: LatLng = { lat: 31.925, lng: 34.995 };

const scored = (worstS: number, meanS = worstS): ScoredCandidate => ({
  point: CENTRE,
  worstS,
  meanS,
});

describe("occupancyMask", () => {
  it("marks each slot by index", () => {
    expect(occupancyMask([TEL_AVIV, null, JERUSALEM, null, null])).toBe(
      "10100",
    );
  });
});

describe("spreadRadius", () => {
  it("is the distance to the farthest position, ignoring vacant slots", () => {
    const radius = spreadRadius(CENTRE, [TEL_AVIV, null, CENTRE]);
    expect(radius).toBeCloseTo(haversineDistance(CENTRE, TEL_AVIV), 6);
  });
});

describe("ringCandidates", () => {
  const radius = 9_000;
  const candidates = ringCandidates(CENTRE, radius);

  it("puts the centre first, so a tie resolves to it", () => {
    expect(candidates[0]).toEqual(CENTRE);
  });

  // The Matrix API refuses more than 25 coordinates; a full session is five
  // sources, these, and the incumbent.
  it("fits a full session and an incumbent in one matrix request", () => {
    expect(candidates).toHaveLength(CANDIDATES_PER_ROUND);
    expect(MAX_PARTICIPANTS + CANDIDATES_PER_ROUND + 1).toBeLessThanOrEqual(
      MATRIX_MAX_COORDINATES,
    );
  });

  it("lays three rings at a third, two thirds and the whole radius", () => {
    const distances = candidates
      .slice(1)
      .map((point) => haversineDistance(CENTRE, point));
    for (let ring = 0; ring < 3; ring++) {
      for (const d of distances.slice(ring * 6, ring * 6 + 6)) {
        expect(d).toBeCloseTo((radius * (ring + 1)) / 3, 0);
      }
    }
  });

  it("never repeats a point", () => {
    const keys = new Set(candidates.map((p) => `${p.lat}:${p.lng}`));
    expect(keys.size).toBe(candidates.length);
  });
});

describe("scoreCandidates", () => {
  it("scores each candidate by its longest and average trip", () => {
    const result = scoreCandidates(
      [
        [600, 1200],
        [900, 300],
      ],
      [TEL_AVIV, JERUSALEM],
    );
    expect(result).toEqual([
      { point: TEL_AVIV, worstS: 900, meanS: 750 },
      { point: JERUSALEM, worstS: 1200, meanS: 750 },
    ]);
  });

  it("gives no score to a candidate somebody cannot reach", () => {
    const result = scoreCandidates(
      [
        [600, null],
        [900, 300],
      ],
      [TEL_AVIV, JERUSALEM],
    );
    expect(result[1]).toBeNull();
    expect(result[0]).not.toBeNull();
  });
});

describe("pickFairest", () => {
  // The point of the feature: the centroid can be halfway in kilometres and
  // twenty minutes apart in time.
  it("prefers the shortest longest trip over the shortest total", () => {
    const lopsided = { point: TEL_AVIV, worstS: 2400, meanS: 1300 };
    const even = { point: JERUSALEM, worstS: 1500, meanS: 1450 };
    expect(pickFairest([lopsided, even])).toBe(even);
  });

  it("breaks a tie on the longest trip by the average", () => {
    const a = { point: TEL_AVIV, worstS: 1500, meanS: 1400 };
    const b = { point: JERUSALEM, worstS: 1500, meanS: 1000 };
    expect(pickFairest([a, b])).toBe(b);
  });

  it("keeps the earliest of exact equals", () => {
    const a = scored(1500);
    const b = scored(1500);
    expect(pickFairest([a, b])).toBe(a);
  });

  it("skips the unreachable, and has no answer when nothing is reachable", () => {
    const only = scored(900);
    expect(pickFairest([null, only, null])).toBe(only);
    expect(pickFairest([null, null])).toBeNull();
  });
});

describe("keepsIncumbent", () => {
  it("keeps a point that is within 90 seconds of the best", () => {
    expect(keepsIncumbent(scored(690), scored(600))).toBe(true);
    expect(keepsIncumbent(scored(691), scored(600))).toBe(false);
  });

  it("scales the margin to a tenth of a long trip", () => {
    expect(keepsIncumbent(scored(3960), scored(3600))).toBe(true);
    expect(keepsIncumbent(scored(3961), scored(3600))).toBe(false);
  });
});

describe("acceptsMeeting", () => {
  const radius = haversineDistance(CENTRE, TEL_AVIV);

  it("accepts a point computed for the people counted, among them", () => {
    expect(
      acceptsMeeting({ point: CENTRE, mask: "11000" }, "11000", CENTRE, radius),
    ).toBe(true);
  });

  it("refuses a point computed for a different group", () => {
    expect(
      acceptsMeeting({ point: CENTRE, mask: "11000" }, "11100", CENTRE, radius),
    ).toBe(false);
  });

  // Left over from wherever the group was while the matrix was unreachable.
  it("refuses a point further away than the people themselves", () => {
    const elsewhere: LatLng = { lat: 32.8, lng: 35.0 };
    expect(
      acceptsMeeting(
        { point: elsewhere, mask: "11000" },
        "11000",
        CENTRE,
        radius,
      ),
    ).toBe(false);
  });

  it("allows for the router snapping a point just outside the group", () => {
    expect(
      acceptsMeeting(
        { point: TEL_AVIV, mask: "11000" },
        "11000",
        CENTRE,
        radius,
      ),
    ).toBe(true);
  });
});

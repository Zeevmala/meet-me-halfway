import { describe, it, expect } from "vitest";
import { candidatePoints, pickFairest } from "./fair-meeting";
import { geographicCentroid, haversineDistance } from "./geo-math";
import type { LatLng } from "./geo-math";

const TEL_AVIV: LatLng = { lat: 32.0853, lng: 34.7818 };
const JERUSALEM: LatLng = { lat: 31.7683, lng: 35.2137 };
const HAIFA: LatLng = { lat: 32.794, lng: 34.9896 };

describe("candidatePoints", () => {
  it("starts with the centroid", () => {
    const centroid = geographicCentroid([TEL_AVIV, JERUSALEM]);

    expect(candidatePoints([TEL_AVIV, JERUSALEM], centroid, 11)[0]).toBe(
      centroid,
    );
  });

  it("spends the budget evenly across people and never exceeds it", () => {
    const two = [TEL_AVIV, JERUSALEM];
    const three = [TEL_AVIV, JERUSALEM, HAIFA];

    expect(candidatePoints(two, geographicCentroid(two), 11)).toHaveLength(11);
    // (11 - 1) / 3 rounds down to three each.
    expect(candidatePoints(three, geographicCentroid(three), 11)).toHaveLength(
      10,
    );
  });

  it("samples between the centroid and each person, never beyond them", () => {
    const people = [TEL_AVIV, JERUSALEM];
    const centroid = geographicCentroid(people);
    const half = haversineDistance(TEL_AVIV, centroid);

    for (const candidate of candidatePoints(people, centroid, 11).slice(1)) {
      const out = haversineDistance(centroid, candidate);
      expect(out).toBeGreaterThan(0);
      expect(out).toBeLessThanOrEqual(half * 0.6 + 1);
    }
  });

  it("is the centroid alone when the budget allows nothing else", () => {
    const people = [TEL_AVIV, JERUSALEM];

    expect(candidatePoints(people, geographicCentroid(people), 1)).toHaveLength(
      1,
    );
  });
});

describe("pickFairest", () => {
  // Candidate 0 is halfway in distance: 20 min for one, 50 for the other.
  // Candidate 1 is nearer the slow one: 33 and 35.
  it("picks the point whose longest trip is shortest", () => {
    const choice = pickFairest([
      [1200, 1980, 2700],
      [3000, 2100, 1500],
    ]);

    expect(choice).toEqual({ index: 1, worstSeconds: 2100 });
  });

  // Arrivals 0 min apart, an hour away from both, is not a meeting point.
  it("does not chase equal arrivals at the cost of everyone's trip", () => {
    const choice = pickFairest([
      [1500, 3600],
      [1800, 3600],
    ]);

    expect(choice?.index).toBe(0);
  });

  it("breaks a tie on the worst trip by the mean", () => {
    const choice = pickFairest([
      [1800, 1800],
      [1700, 900],
    ]);

    expect(choice?.index).toBe(1);
  });

  it("keeps the earliest of equals — the centroid", () => {
    expect(
      pickFairest([
        [600, 600, 600],
        [600, 600, 600],
      ])?.index,
    ).toBe(0);
  });

  it("skips a candidate somebody cannot reach", () => {
    const choice = pickFairest([
      [100, 900],
      [null, 900],
    ]);

    expect(choice).toEqual({ index: 1, worstSeconds: 900 });
  });

  it("answers null when nobody can reach anything", () => {
    expect(pickFairest([[null], [null]])).toBeNull();
    expect(pickFairest([])).toBeNull();
  });

  describe("with a current meeting point", () => {
    // 30 s better is not worth moving the place people are driving to.
    it("keeps it against a marginal improvement", () => {
      const choice = pickFairest(
        [
          [1800, 1770],
          [1800, 1770],
        ],
        0,
      );

      expect(choice).toEqual({ index: 0, worstSeconds: 1800 });
    });

    it("gives it up for a real one", () => {
      const choice = pickFairest(
        [
          [1800, 1500],
          [1800, 1500],
        ],
        0,
      );

      expect(choice?.index).toBe(1);
    });

    it("gives it up when it can no longer be reached", () => {
      const choice = pickFairest(
        [
          [null, 1790],
          [1800, 1790],
        ],
        0,
      );

      expect(choice?.index).toBe(1);
    });
  });
});

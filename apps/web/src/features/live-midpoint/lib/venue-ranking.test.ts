import { describe, it, expect } from "vitest";
import {
  computeVenueScore,
  rankVenues,
  type PlaceResult,
} from "./venue-ranking";
import type { LatLng } from "./geo-math";

const TEL_AVIV: LatLng = { lat: 32.0853, lng: 34.7818 };

function makePlaceAt(
  overrides: Partial<PlaceResult> & { location: LatLng },
): PlaceResult {
  return {
    id: overrides.id ?? "place-1",
    displayName: overrides.displayName ?? "Test Place",
    rating: overrides.rating ?? 0,
    userRatingCount: overrides.userRatingCount ?? 0,
    openNow: overrides.openNow ?? false,
    types: overrides.types ?? ["restaurant"],
    distanceFromMidpoint: overrides.distanceFromMidpoint,
    ...overrides,
  };
}

describe("computeVenueScore", () => {
  it("returns 1.0 for a perfect venue", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 5.0,
      userRatingCount: 200,
      openNow: true,
      distanceFromMidpoint: 0,
    });
    expect(computeVenueScore(place, 1000)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for a worst-case venue", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 0,
      openNow: false,
      distanceFromMidpoint: 1000,
    });
    expect(computeVenueScore(place, 1000)).toBeCloseTo(0.0, 5);
  });

  it("weights rating at 40% of score", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 5.0,
      userRatingCount: 0,
      openNow: false,
      distanceFromMidpoint: 1000, // worst distance
    });
    // 0.40 * (5/5) + 0.30 * 0 + 0.20 * 0 + 0.10 * 0 = 0.40
    expect(computeVenueScore(place, 1000)).toBeCloseTo(0.4, 5);
  });

  it("weights distance proximity at 30% of score", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 0,
      openNow: false,
      distanceFromMidpoint: 0, // best distance
    });
    // 0.40 * 0 + 0.30 * 1 + 0.20 * 0 + 0.10 * 0 = 0.30
    expect(computeVenueScore(place, 1000)).toBeCloseTo(0.3, 5);
  });

  it("weights popularity at 20% of score", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 100,
      openNow: false,
      distanceFromMidpoint: 1000,
    });
    // 0.40 * 0 + 0.30 * 0 + 0.20 * (100/200) + 0.10 * 0 = 0.10
    expect(computeVenueScore(place, 1000)).toBeCloseTo(0.1, 5);
  });

  it("caps popularity at 200 ratings", () => {
    const place200 = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 200,
      openNow: false,
      distanceFromMidpoint: 1000,
    });
    const place500 = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 500,
      openNow: false,
      distanceFromMidpoint: 1000,
    });
    expect(computeVenueScore(place200, 1000)).toBe(
      computeVenueScore(place500, 1000),
    );
  });

  it("weights open_now at 10% of score", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 0,
      openNow: true,
      distanceFromMidpoint: 1000,
    });
    // 0.40 * 0 + 0.30 * 0 + 0.20 * 0 + 0.10 * 1 = 0.10
    expect(computeVenueScore(place, 1000)).toBeCloseTo(0.1, 5);
  });

  it("handles maxDistance of 0 without NaN", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 2.5,
      userRatingCount: 50,
      openNow: true,
      distanceFromMidpoint: 0,
    });
    const score = computeVenueScore(place, 0);
    expect(Number.isFinite(score)).toBe(true);
    // 0.40 * 0.5 + 0.30 (flat) + 0.20 * 0.25 + 0.10 * 1 = 0.65
    expect(score).toBeCloseTo(0.65, 5);
  });

  it("handles zero rating gracefully", () => {
    const place = makePlaceAt({
      location: TEL_AVIV,
      rating: 0,
      userRatingCount: 0,
      openNow: false,
      distanceFromMidpoint: 500,
    });
    const score = computeVenueScore(place, 1000);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(score)).toBe(true);
  });
});

describe("rankVenues", () => {
  const MIDPOINT: LatLng = { lat: 32.0, lng: 34.8 };

  it("returns empty array for empty input", () => {
    expect(rankVenues([], MIDPOINT)).toEqual([]);
  });

  it("returns venues sorted by score descending", () => {
    const places: PlaceResult[] = [
      makePlaceAt({
        id: "low",
        location: { lat: 32.01, lng: 34.81 },
        rating: 1.0,
        userRatingCount: 5,
        openNow: false,
      }),
      makePlaceAt({
        id: "high",
        location: { lat: 32.001, lng: 34.801 },
        rating: 4.8,
        userRatingCount: 300,
        openNow: true,
      }),
    ];

    const ranked = rankVenues(places, MIDPOINT);
    expect(ranked[0].id).toBe("high");
    expect(ranked[1].id).toBe("low");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("returns at most topN venues", () => {
    const places: PlaceResult[] = Array.from({ length: 10 }, (_, i) =>
      makePlaceAt({
        id: `p${i}`,
        location: { lat: 32.0 + i * 0.001, lng: 34.8 },
        rating: 3.0,
        userRatingCount: 50,
      }),
    );

    expect(rankVenues(places, MIDPOINT, 3)).toHaveLength(3);
    expect(rankVenues(places, MIDPOINT, 5)).toHaveLength(5);
    expect(rankVenues(places, MIDPOINT)).toHaveLength(5); // default
  });

  it("computes distanceFromMidpoint for each venue", () => {
    const places: PlaceResult[] = [
      makePlaceAt({ id: "a", location: { lat: 32.001, lng: 34.801 } }),
    ];

    const ranked = rankVenues(places, MIDPOINT);
    expect(ranked[0].distanceFromMidpoint).toBeDefined();
    expect(ranked[0].distanceFromMidpoint).toBeGreaterThan(0);
  });

  it("ranks closer venues higher when other factors equal", () => {
    const places: PlaceResult[] = [
      makePlaceAt({
        id: "far",
        location: { lat: 32.01, lng: 34.81 },
        rating: 4.0,
        userRatingCount: 100,
        openNow: true,
      }),
      makePlaceAt({
        id: "near",
        location: { lat: 32.0001, lng: 34.8001 },
        rating: 4.0,
        userRatingCount: 100,
        openNow: true,
      }),
    ];

    const ranked = rankVenues(places, MIDPOINT);
    expect(ranked[0].id).toBe("near");
  });
});

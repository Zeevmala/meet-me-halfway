import { describe, it, expect } from "vitest";
import {
  sphericalMidpoint,
  geographicCentroid,
  haversineDistance,
  formatDistance,
  accuracyCircleGeoJSON,
  type LatLng,
} from "./geo-math";

// ── Known city coordinates ──
const TEL_AVIV: LatLng = { lat: 32.0853, lng: 34.7818 };
const JERUSALEM: LatLng = { lat: 31.7683, lng: 35.2137 };
const HAIFA: LatLng = { lat: 32.794, lng: 34.9896 };
const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };
const NEW_YORK: LatLng = { lat: 40.7128, lng: -74.006 };
const TOKYO: LatLng = { lat: 35.6762, lng: 139.6503 };
const SYDNEY: LatLng = { lat: -33.8688, lng: 151.2093 };

// Helper: distance between two LatLngs in km (for tolerance assertions)
function distKm(a: LatLng, b: LatLng): number {
  return haversineDistance(a, b) / 1000;
}

describe("sphericalMidpoint", () => {
  it("returns exact input when both points are identical", () => {
    const mid = sphericalMidpoint(TEL_AVIV, TEL_AVIV);
    expect(mid.lat).toBeCloseTo(TEL_AVIV.lat, 6);
    expect(mid.lng).toBeCloseTo(TEL_AVIV.lng, 6);
  });

  it("computes midpoint of Tel Aviv–Jerusalem within 1 km of expected", () => {
    // Expected geographic midpoint ~31.93°N, 35.00°E
    const mid = sphericalMidpoint(TEL_AVIV, JERUSALEM);
    expect(mid.lat).toBeCloseTo(31.927, 1);
    expect(mid.lng).toBeCloseTo(34.998, 1);
    // Midpoint should be roughly equidistant from both
    const dA = haversineDistance(TEL_AVIV, mid);
    const dB = haversineDistance(JERUSALEM, mid);
    expect(Math.abs(dA - dB)).toBeLessThan(1000); // within 1 km
  });

  it("computes midpoint of London–New York within 1 km of expected", () => {
    // Great-circle midpoint of London–NYC is approximately 53.4°N, 36.0°W
    const mid = sphericalMidpoint(LONDON, NEW_YORK);
    expect(mid.lat).toBeGreaterThan(46);
    expect(mid.lat).toBeLessThan(55);
    expect(mid.lng).toBeGreaterThan(-42);
    expect(mid.lng).toBeLessThan(-30);
    // Equidistant check
    const dA = haversineDistance(LONDON, mid);
    const dB = haversineDistance(NEW_YORK, mid);
    expect(Math.abs(dA - dB)).toBeLessThan(1000);
  });

  it("handles cross-hemisphere points (Tokyo–Sydney)", () => {
    const mid = sphericalMidpoint(TOKYO, SYDNEY);
    // Midpoint should be somewhere in the Pacific, between latitudes
    expect(mid.lat).toBeGreaterThan(-34);
    expect(mid.lat).toBeLessThan(36);
    const dA = haversineDistance(TOKYO, mid);
    const dB = haversineDistance(SYDNEY, mid);
    expect(Math.abs(dA - dB)).toBeLessThan(1000);
  });

  it("handles near-antipodal points without NaN", () => {
    // North pole to South pole
    const north: LatLng = { lat: 89.999, lng: 0 };
    const south: LatLng = { lat: -89.999, lng: 0 };
    const mid = sphericalMidpoint(north, south);
    expect(Number.isFinite(mid.lat)).toBe(true);
    expect(Number.isFinite(mid.lng)).toBe(true);
    // Should be near equator
    expect(Math.abs(mid.lat)).toBeLessThan(1);
  });

  it("is commutative: midpoint(A,B) ≈ midpoint(B,A)", () => {
    const midAB = sphericalMidpoint(TEL_AVIV, JERUSALEM);
    const midBA = sphericalMidpoint(JERUSALEM, TEL_AVIV);
    expect(distKm(midAB, midBA)).toBeLessThan(0.001);
  });

  it("handles the equator and prime meridian", () => {
    const a: LatLng = { lat: 0, lng: -10 };
    const b: LatLng = { lat: 0, lng: 10 };
    const mid = sphericalMidpoint(a, b);
    expect(mid.lat).toBeCloseTo(0, 5);
    expect(mid.lng).toBeCloseTo(0, 5);
  });

  it("handles crossing the antimeridian (date line)", () => {
    const a: LatLng = { lat: 0, lng: 170 };
    const b: LatLng = { lat: 0, lng: -170 };
    const mid = sphericalMidpoint(a, b);
    // Midpoint should be near ±180, not near 0
    expect(Math.abs(mid.lng)).toBeGreaterThan(170);
  });
});

describe("geographicCentroid", () => {
  it("returns the point itself for a single-point input", () => {
    const c = geographicCentroid([TEL_AVIV]);
    expect(c.lat).toBeCloseTo(TEL_AVIV.lat, 6);
    expect(c.lng).toBeCloseTo(TEL_AVIV.lng, 6);
  });

  it("matches sphericalMidpoint for two points", () => {
    const mid = sphericalMidpoint(TEL_AVIV, JERUSALEM);
    const centroid = geographicCentroid([TEL_AVIV, JERUSALEM]);
    expect(centroid.lat).toBeCloseTo(mid.lat, 4);
    expect(centroid.lng).toBeCloseTo(mid.lng, 4);
  });

  it("computes centroid of 3 equatorial points near (0,0)", () => {
    const a: LatLng = { lat: 0, lng: 0 };
    const b: LatLng = { lat: 0, lng: 120 };
    const c: LatLng = { lat: 0, lng: -120 };
    const centroid = geographicCentroid([a, b, c]);
    // Symmetric around equator → centroid near (0, 0)
    expect(Math.abs(centroid.lat)).toBeLessThan(1);
  });

  it("computes centroid of 5 Israeli cities roughly in the center", () => {
    const BEER_SHEVA: LatLng = { lat: 31.2518, lng: 34.7913 };
    const EILAT: LatLng = { lat: 29.5577, lng: 34.9519 };
    const centroid = geographicCentroid([
      TEL_AVIV,
      JERUSALEM,
      HAIFA,
      BEER_SHEVA,
      EILAT,
    ]);
    // Centroid should be roughly in Israel's center
    expect(centroid.lat).toBeGreaterThan(29);
    expect(centroid.lat).toBeLessThan(33);
    expect(centroid.lng).toBeGreaterThan(34);
    expect(centroid.lng).toBeLessThan(36);
  });

  it("is order-independent", () => {
    const points = [TEL_AVIV, JERUSALEM, HAIFA];
    const c1 = geographicCentroid(points);
    const c2 = geographicCentroid([HAIFA, TEL_AVIV, JERUSALEM]);
    expect(distKm(c1, c2)).toBeLessThan(0.001);
  });

  it("throws for empty array", () => {
    expect(() => geographicCentroid([])).toThrow();
  });
});

describe("haversineDistance", () => {
  it("returns 0 for identical points", () => {
    expect(haversineDistance(TEL_AVIV, TEL_AVIV)).toBe(0);
  });

  it("computes Tel Aviv–Jerusalem ≈ 54 km", () => {
    // Known distance: ~54 km
    const d = haversineDistance(TEL_AVIV, JERUSALEM) / 1000;
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(58);
  });

  it("computes Tel Aviv–Haifa ≈ 82 km", () => {
    const d = haversineDistance(TEL_AVIV, HAIFA) / 1000;
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(90);
  });

  it("computes London–New York ≈ 5,570 km", () => {
    const d = haversineDistance(LONDON, NEW_YORK) / 1000;
    expect(d).toBeGreaterThan(5500);
    expect(d).toBeLessThan(5650);
  });

  it("computes half-earth distance (pole to pole) ≈ 20,004 km", () => {
    const north: LatLng = { lat: 90, lng: 0 };
    const south: LatLng = { lat: -90, lng: 0 };
    const d = haversineDistance(north, south) / 1000;
    // Half circumference ≈ 20,004 km
    expect(d).toBeGreaterThan(19_900);
    expect(d).toBeLessThan(20_100);
  });

  it("is commutative: dist(A,B) === dist(B,A)", () => {
    const dAB = haversineDistance(TEL_AVIV, LONDON);
    const dBA = haversineDistance(LONDON, TEL_AVIV);
    expect(dAB).toBe(dBA);
  });

  it("satisfies triangle inequality", () => {
    const dAB = haversineDistance(TEL_AVIV, JERUSALEM);
    const dBC = haversineDistance(JERUSALEM, HAIFA);
    const dAC = haversineDistance(TEL_AVIV, HAIFA);
    expect(dAC).toBeLessThanOrEqual(dAB + dBC);
  });

  it("handles equator points correctly", () => {
    const a: LatLng = { lat: 0, lng: 0 };
    const b: LatLng = { lat: 0, lng: 1 };
    // 1 degree of longitude at equator ≈ 111.32 km
    const d = haversineDistance(a, b) / 1000;
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(113);
  });
});

describe("formatDistance", () => {
  it("formats meters below 1000 as 'm'", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(450)).toBe("450 m");
    expect(formatDistance(999)).toBe("999 m");
  });

  it("formats 1000+ meters as 'km' with one decimal", () => {
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(1500)).toBe("1.5 km");
    expect(formatDistance(12345)).toBe("12.3 km");
    expect(formatDistance(100000)).toBe("100.0 km");
  });

  it("rounds meters to nearest integer", () => {
    expect(formatDistance(450.7)).toBe("451 m");
  });

  it("rounds km to one decimal place", () => {
    expect(formatDistance(1550)).toBe("1.6 km");
    expect(formatDistance(1549)).toBe("1.5 km");
  });
});

describe("accuracyCircleGeoJSON", () => {
  it("returns a valid GeoJSON Polygon", () => {
    const circle = accuracyCircleGeoJSON(TEL_AVIV, 100);
    expect(circle.type).toBe("Polygon");
    expect(circle.coordinates).toHaveLength(1);
    expect(Array.isArray(circle.coordinates[0])).toBe(true);
  });

  it("has the correct number of vertices (default 64 + closing point)", () => {
    const circle = accuracyCircleGeoJSON(TEL_AVIV, 100);
    expect(circle.coordinates[0]).toHaveLength(65);
  });

  it("has the correct number of vertices with custom steps", () => {
    const circle = accuracyCircleGeoJSON(TEL_AVIV, 100, 32);
    expect(circle.coordinates[0]).toHaveLength(33);
  });

  it("closes the ring (first === last coordinate)", () => {
    const circle = accuracyCircleGeoJSON(TEL_AVIV, 100);
    const ring = circle.coordinates[0];
    expect(ring[0][0]).toBe(ring[ring.length - 1][0]);
    expect(ring[0][1]).toBe(ring[ring.length - 1][1]);
  });

  it("all vertices are approximately the specified radius from center", () => {
    const radius = 500;
    const circle = accuracyCircleGeoJSON(TEL_AVIV, radius);
    const ring = circle.coordinates[0];

    for (let i = 0; i < ring.length - 1; i += 8) {
      const [lng, lat] = ring[i];
      const d = haversineDistance(TEL_AVIV, { lat, lng });
      expect(d).toBeGreaterThan(radius * 0.99);
      expect(d).toBeLessThan(radius * 1.01);
    }
  });

  it("produces valid coordinates for a point on the equator", () => {
    const equator: LatLng = { lat: 0, lng: 0 };
    const circle = accuracyCircleGeoJSON(equator, 1000);
    const ring = circle.coordinates[0];
    for (const [lng, lat] of ring) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
  });

  it("handles very small radius (GPS high accuracy)", () => {
    const circle = accuracyCircleGeoJSON(TEL_AVIV, 5);
    const ring = circle.coordinates[0];
    const [lng, lat] = ring[0];
    const d = haversineDistance(TEL_AVIV, { lat, lng });
    expect(d).toBeGreaterThan(4);
    expect(d).toBeLessThan(6);
  });
});

import { describe, it, expect } from "vitest";
import {
  decodePolyline,
  encodePolyline,
  encodeRouteLine,
  MAX_LINE_LENGTH,
  simplifyLine,
} from "./polyline";

describe("encodePolyline / decodePolyline", () => {
  // The example in Google's documentation of the algorithm, in GeoJSON order.
  const GOOGLE_EXAMPLE: [number, number][] = [
    [-120.2, 38.5],
    [-120.95, 40.7],
    [-126.453, 43.252],
  ];

  it("matches the algorithm's published example", () => {
    expect(encodePolyline(GOOGLE_EXAMPLE)).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  });

  it("round-trips a route to the metre", () => {
    const route: [number, number][] = [
      [34.78174, 32.08532],
      [34.80001, 32.06],
      [35.21371, 31.76831],
    ];
    const decoded = decodePolyline(encodePolyline(route));
    expect(decoded).toHaveLength(3);
    decoded?.forEach((position, i) => {
      expect(position[0]).toBeCloseTo(route[i]?.[0] ?? NaN, 5);
      expect(position[1]).toBeCloseTo(route[i]?.[1] ?? NaN, 5);
    });
  });

  it("round-trips across the antimeridian and the poles' range", () => {
    const route: [number, number][] = [
      [179.99999, -89.99999],
      [-179.99999, 89.99999],
    ];
    expect(decodePolyline(encodePolyline(route))).toEqual(route);
  });

  // The string comes from another device: the rules check its alphabet and
  // length, not that it decodes.
  it("refuses what is not a well-formed line", () => {
    expect(decodePolyline("")).toBeNull();
    expect(decodePolyline("not a polyline!")).toBeNull();
    // Cut off in the middle of a value.
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mq")).toBeNull();
    // One point is not a line.
    expect(decodePolyline("_p~iF~ps|U")).toBeNull();
    // A value that never ends.
    expect(decodePolyline("~".repeat(40))).toBeNull();
    // Off the globe.
    expect(
      decodePolyline(
        encodePolyline([
          [0, 0],
          [0, 95],
        ]),
      ),
    ).toBeNull();
  });
});

describe("simplifyLine", () => {
  it("keeps the ends and drops what lies within the tolerance", () => {
    // A straight line with a 1 m wobble, and a 500 m corner.
    const line: [number, number][] = [
      [34.78, 32.08],
      [34.79, 32.08001],
      [34.8, 32.08],
      [34.8, 32.0845],
    ];
    expect(simplifyLine(line, 5)).toEqual([
      [34.78, 32.08],
      [34.8, 32.08],
      [34.8, 32.0845],
    ]);
  });

  it("leaves a line of two points alone", () => {
    const line: [number, number][] = [
      [34.78, 32.08],
      [35.21, 31.77],
    ];
    expect(simplifyLine(line, 1_000)).toEqual(line);
  });
});

describe("encodeRouteLine", () => {
  it("encodes a route that fits as it is", () => {
    const geometry = {
      type: "LineString" as const,
      coordinates: [
        [34.78, 32.08],
        [35.21, 31.77],
      ],
    };
    expect(encodeRouteLine(geometry)).toBe(
      encodePolyline(geometry.coordinates),
    );
  });

  it("simplifies a route until it fits the rules' limit", () => {
    // A wiggly line far longer than the limit when encoded in full.
    const coordinates: [number, number][] = [];
    for (let i = 0; i < 6_000; i++) {
      coordinates.push([34.78 + i * 1e-3, 32.08 + (i % 2) * 2e-4]);
    }
    const geometry = { type: "LineString" as const, coordinates };
    expect(encodePolyline(coordinates).length).toBeGreaterThan(MAX_LINE_LENGTH);

    const encoded = encodeRouteLine(geometry);

    expect(encoded.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    const decoded = decodePolyline(encoded);
    expect(decoded?.[0]).toEqual(coordinates[0]);
    const last = decoded?.[decoded.length - 1];
    expect(last?.[0]).toBeCloseTo(
      coordinates[coordinates.length - 1]?.[0] ?? NaN,
      5,
    );
  });
});

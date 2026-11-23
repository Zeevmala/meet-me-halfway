import { describe, it, expect } from "vitest";
import {
  ARRIVAL_RADIUS_M,
  etaMinutes,
  etaParts,
  etaSpreadMinutes,
  hasArrived,
} from "./eta";
import { destinationPoint } from "./geo-math";

describe("etaMinutes", () => {
  it("rounds up to the whole minute", () => {
    expect(etaMinutes(60)).toBe(1);
    expect(etaMinutes(61)).toBe(2);
    expect(etaMinutes(2400)).toBe(40);
  });
});

describe("etaParts", () => {
  it("keeps a trip under an hour in minutes", () => {
    expect(etaParts(1980)).toEqual({ hours: 0, minutes: 33 });
  });

  it("splits an hour or more into hours and minutes", () => {
    expect(etaParts(4500)).toEqual({ hours: 1, minutes: 15 });
    expect(etaParts(7200)).toEqual({ hours: 2, minutes: 0 });
  });
});

describe("etaSpreadMinutes", () => {
  it("is the gap between the first and the last to arrive", () => {
    expect(
      etaSpreadMinutes([
        { duration: 1980 },
        { duration: 2220 },
        { duration: 780 },
      ]),
    ).toBe(24);
  });

  it("is null until two people have a route", () => {
    expect(etaSpreadMinutes([])).toBeNull();
    expect(etaSpreadMinutes([{ duration: 600 }, null])).toBeNull();
  });

  it("is zero for arrivals in the same minute", () => {
    expect(etaSpreadMinutes([{ duration: 600 }, { duration: 590 }])).toBe(0);
  });
});

describe("hasArrived", () => {
  const destination = { lat: 31.925, lng: 34.995 };

  it("counts someone within the arrival radius as there", () => {
    const near = destinationPoint(destination, 40, ARRIVAL_RADIUS_M - 5);
    expect(hasArrived(near, destination)).toBe(true);
  });

  it("does not count someone still down the street", () => {
    const far = destinationPoint(destination, 40, ARRIVAL_RADIUS_M + 25);
    expect(hasArrived(far, destination)).toBe(false);
  });
});

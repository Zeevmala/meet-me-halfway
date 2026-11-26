import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDirectionsClient } from "./directions-api";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const FROM = { lat: 32.08, lng: 34.78 };
const TO = { lat: 31.77, lng: 35.21 };
const ROUTE = {
  geometry: { type: "LineString", coordinates: [] },
  duration: 3000,
  distance: 60000,
};

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ routes: [ROUTE] }),
  });
});

describe("createDirectionsClient", () => {
  const fetchRoute = createDirectionsClient("tok");
  const signal = new AbortController().signal;

  // The ETA is what the card leads with; without traffic it is the same
  // number at rush hour as at night.
  it("asks for driving routes with live traffic", async () => {
    await fetchRoute(FROM, TO, "driving", signal);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/mapbox/driving-traffic/34.78,32.08;35.21,31.77");
  });

  it("asks for walking routes as walking", async () => {
    await fetchRoute(FROM, TO, "walking", signal);

    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/mapbox/walking/");
  });

  it("returns the first route", async () => {
    const result = await fetchRoute(FROM, TO, "driving", signal);

    expect(result).toEqual({ ok: true, value: ROUTE });
  });

  it("answers null when Mapbox has no route", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ routes: [] }),
    });

    expect(await fetchRoute(FROM, TO, "driving", signal)).toEqual({
      ok: true,
      value: null,
    });
  });
});

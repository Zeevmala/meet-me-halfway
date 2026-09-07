import { describe, it, expect, vi } from "vitest";
import { createVenuePolicy, createRoutePolicy } from "./policies";
import type { RouteInput, VenueInput } from "./policies";
import type { GraphPorts } from "./ports";
import type { LatLng } from "../lib/geo-math";
import { ok, err } from "../../../core/dag/result";
import type { TimerId } from "../../../core/dag/resource";

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
// ~50 m from TEL_AVIV — inside both admission thresholds.
const NEARBY: LatLng = { lat: 32.0804, lng: 34.7803 };
// ~1.2 km from TEL_AVIV — outside both.
const FAR: LatLng = { lat: 32.09, lng: 34.79 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };

function makePorts(overrides: Partial<GraphPorts> = {}): GraphPorts {
  return {
    now: () => 0,
    schedule: () => 0 as unknown as TimerId,
    cancel: () => {},
    searchVenues: vi.fn().mockResolvedValue(ok([])),
    fetchRoute: vi.fn().mockResolvedValue(ok(null)),
    placesEnabled: true,
    ...overrides,
  };
}

function venueInput(center: LatLng): VenueInput {
  return { center };
}

function routeInput(
  slots: readonly (LatLng | null)[],
  dest: LatLng,
  profile: "driving" | "walking" = "driving",
): RouteInput {
  return { slots, dest, profile };
}

describe("venue policy", () => {
  const policy = createVenuePolicy(makePorts());

  it("does not admit a move inside the 100m cache radius", () => {
    expect(policy.admits(venueInput(TEL_AVIV), venueInput(NEARBY), 0, 0)).toBe(
      false,
    );
  });

  it("admits a move beyond the cache radius", () => {
    expect(policy.admits(venueInput(TEL_AVIV), venueInput(FAR), 0, 0)).toBe(
      true,
    );
  });

  // Without a TTL, lastSearchCenterRef never expired: a user standing still
  // for two hours saw openNow from two hours ago.
  it("admits a stationary refresh once the results age past the TTL", () => {
    const stationary = venueInput(TEL_AVIV);
    expect(policy.admits(stationary, stationary, 0, 60_000)).toBe(false);
    expect(policy.admits(stationary, stationary, 0, 5 * 60_000)).toBe(true);
  });

  it("derives a deterministic identity that separates distant centres", () => {
    expect(policy.identity(venueInput(TEL_AVIV))).toBe(
      policy.identity(venueInput({ ...TEL_AVIV })),
    );
    expect(policy.identity(venueInput(TEL_AVIV))).not.toBe(
      policy.identity(venueInput(FAR)),
    );
  });

  // Two points 50m apart can still land in different cells if they straddle a
  // boundary. That is inherent to grid quantisation and is exactly why
  // `identity` only collapses duplicate in-flight requests and never decides
  // admission: as an admission gate, a stationary user sitting on a boundary
  // would flip cells on GPS noise and pay for a search every few seconds.
  it("does not promise that nearby centres share a cell", () => {
    const nearbyShareCell =
      policy.identity(venueInput(TEL_AVIV)) ===
      policy.identity(venueInput(NEARBY));
    // Whatever the grid does here, admission is unaffected.
    expect(policy.admits(venueInput(TEL_AVIV), venueInput(NEARBY), 0, 0)).toBe(
      false,
    );
    expect(typeof nearbyShareCell).toBe("boolean");
  });
});

describe("route policy", () => {
  const policy = createRoutePolicy(makePorts());
  const base = routeInput([TEL_AVIV, JERUSALEM, null, null, null], TEL_AVIV);

  it("does not admit movement inside the 200m threshold", () => {
    const next = routeInput([NEARBY, JERUSALEM, null, null, null], TEL_AVIV);
    expect(policy.admits(base, next, 0, 0)).toBe(false);
  });

  it("admits movement beyond the threshold on any slot", () => {
    const next = routeInput([FAR, JERUSALEM, null, null, null], TEL_AVIV);
    expect(policy.admits(base, next, 0, 0)).toBe(true);
  });

  it("admits a destination move beyond the threshold", () => {
    const next = routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR);
    expect(policy.admits(base, next, 0, 0)).toBe(true);
  });

  it("admits a travel profile change", () => {
    const next = routeInput(
      [TEL_AVIV, JERUSALEM, null, null, null],
      TEL_AVIV,
      "walking",
    );
    expect(policy.admits(base, next, 0, 0)).toBe(true);
  });

  // The old guard compared participant *count*, so one person leaving as
  // another joined looked identical and the routes were never refetched.
  it("admits a change of occupancy that keeps the count the same", () => {
    const swapped = routeInput(
      [TEL_AVIV, null, JERUSALEM, null, null],
      TEL_AVIV,
    );
    expect(policy.admits(base, swapped, 0, 0)).toBe(true);
    expect(policy.identity(base)).not.toBe(policy.identity(swapped));
  });

  it("admits a stationary refresh once routes age past the TTL", () => {
    expect(policy.admits(base, base, 0, 30_000)).toBe(false);
    expect(policy.admits(base, base, 0, 60_000)).toBe(true);
  });

  it("returns routes keyed by slot", async () => {
    const fetchRoute = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          geometry: { type: "LineString", coordinates: [] },
          duration: 1,
          distance: 11,
        }),
      )
      .mockResolvedValueOnce(
        ok({
          geometry: { type: "LineString", coordinates: [] },
          duration: 2,
          distance: 22,
        }),
      );
    const p = createRoutePolicy(makePorts({ fetchRoute }));
    const input = routeInput([null, TEL_AVIV, null, JERUSALEM, null], FAR);

    const result = await p.run(input, new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toBeNull();
    expect(result.value[1]?.distance).toBe(11);
    expect(result.value[3]?.distance).toBe(22);
  });

  // Regression: Promise.all meant one participant's 429 discarded every
  // route, and setRoutes never fired at all.
  it("keeps the surviving routes when one slot fails", async () => {
    const fetchRoute = vi
      .fn()
      .mockResolvedValueOnce(err({ kind: "RATE_LIMITED", retryAfterMs: 0 }))
      .mockResolvedValueOnce(
        ok({
          geometry: { type: "LineString", coordinates: [] },
          duration: 2,
          distance: 22,
        }),
      );
    const p = createRoutePolicy(makePorts({ fetchRoute }));
    const input = routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR);

    const result = await p.run(input, new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]).toBeNull();
    expect(result.value[1]?.distance).toBe(22);
  });

  // But a total wipeout is a real outage and must reach the breaker.
  it("reports a failure when every slot fails", async () => {
    const fetchRoute = vi
      .fn()
      .mockResolvedValue(err({ kind: "RATE_LIMITED", retryAfterMs: 0 }));
    const p = createRoutePolicy(makePorts({ fetchRoute }));
    const input = routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR);

    const result = await p.run(input, new AbortController().signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RATE_LIMITED");
  });
});

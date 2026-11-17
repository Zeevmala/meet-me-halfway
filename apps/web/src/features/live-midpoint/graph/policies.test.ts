import { describe, it, expect, vi } from "vitest";
import {
  createMeetPolicy,
  createVenuePolicy,
  createRoutePolicy,
  createTripPolicy,
  MEET_REFRESH_MS,
  PEER_TRIP_ADMIT_M,
  ROUTE_REFRESH_MS,
  routeAnswers,
  TRIP_REFRESH_MS,
  tripAnswers,
} from "./policies";
import type { MeetInput, RouteInput, TripInput, VenueInput } from "./policies";
import type { RouteInfo } from "./types";
import { decodePolyline } from "../lib/polyline";
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
    writePresence: vi.fn().mockResolvedValue(ok(undefined)),
    removePresence: vi.fn(),
    writeMeet: vi.fn().mockResolvedValue(ok(undefined)),
    removeMeet: vi.fn(),
    writeTrip: vi.fn().mockResolvedValue(ok(undefined)),
    removeTrip: vi.fn(),
    placesEnabled: true,
    ...overrides,
  };
}

function venueInput(center: LatLng): VenueInput {
  return { center };
}

function routeInput(
  from: LatLng,
  dest: LatLng,
  profile: "driving" | "walking" = "driving",
): RouteInput {
  return { from, dest, profile };
}

const ROUTE: RouteInfo = {
  geometry: {
    type: "LineString",
    coordinates: [
      [TEL_AVIV.lng, TEL_AVIV.lat],
      [JERUSALEM.lng, JERUSALEM.lat],
    ],
  },
  duration: 3_600,
  distance: 60_000,
};

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

describe("route policy — own route only", () => {
  const policy = createRoutePolicy(makePorts());
  const base = routeInput(TEL_AVIV, JERUSALEM);

  it("does not admit movement inside the 200m threshold", () => {
    expect(policy.admits(base, routeInput(NEARBY, JERUSALEM), 0, 0)).toBe(
      false,
    );
  });

  it("admits own movement beyond the threshold", () => {
    expect(policy.admits(base, routeInput(FAR, JERUSALEM), 0, 0)).toBe(true);
  });

  it("admits a destination move beyond the threshold", () => {
    expect(policy.admits(base, routeInput(TEL_AVIV, FAR), 0, 0)).toBe(true);
  });

  it("admits a travel profile change", () => {
    expect(
      policy.admits(base, routeInput(TEL_AVIV, JERUSALEM, "walking"), 0, 0),
    ).toBe(true);
  });

  // `driving` and `walking` are not traffic-aware: asking the same question
  // every minute, as it did, got the same answer.
  it("admits a stationary refresh only once the route ages past the refresh", () => {
    expect(policy.admits(base, base, 0, 60_000)).toBe(false);
    expect(policy.admits(base, base, 0, ROUTE_REFRESH_MS)).toBe(true);
  });

  it("derives an identity that separates distant starts and destinations", () => {
    expect(policy.identity(base)).toBe(policy.identity({ ...base }));
    expect(policy.identity(base)).not.toBe(
      policy.identity(routeInput(FAR, JERUSALEM)),
    );
    expect(policy.identity(base)).not.toBe(
      policy.identity(routeInput(TEL_AVIV, FAR)),
    );
  });

  // Each device routes its own trip and publishes it. Every device used to
  // route everyone: five people, twenty-five requests for one person's move,
  // and every position sent to Mapbox by every device.
  it("asks Mapbox for this device's route alone, and tags it with what it answers", async () => {
    const fetchRoute = vi.fn().mockResolvedValue(ok(ROUTE));
    const p = createRoutePolicy(makePorts({ fetchRoute }));

    const result = await p.run(
      routeInput(TEL_AVIV, JERUSALEM, "walking"),
      new AbortController().signal,
    );

    expect(fetchRoute).toHaveBeenCalledTimes(1);
    expect(fetchRoute).toHaveBeenCalledWith(
      TEL_AVIV,
      JERUSALEM,
      "walking",
      expect.anything(),
    );
    expect(result).toEqual(
      ok({ dest: JERUSALEM, profile: "walking", route: ROUTE }),
    );
  });

  it("answers with no route when Mapbox has no way there", async () => {
    const p = createRoutePolicy(makePorts());

    const result = await p.run(base, new AbortController().signal);

    expect(result).toEqual(
      ok({ dest: JERUSALEM, profile: "driving", route: null }),
    );
  });

  it("reports a failure", async () => {
    const fetchRoute = vi
      .fn()
      .mockResolvedValue(err({ kind: "RATE_LIMITED", retryAfterMs: 0 }));
    const p = createRoutePolicy(makePorts({ fetchRoute }));

    const result = await p.run(base, new AbortController().signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("RATE_LIMITED");
  });
});

describe("trip policy", () => {
  const input: TripInput = {
    code: "ABC234",
    slot: 1,
    dest: JERUSALEM,
    profile: "driving",
    route: ROUTE,
  };

  // A route asked for as Navigate is tapped may land as the page goes to the
  // background: it is the one the others want to see.
  it("writes at once, with no debounce", () => {
    const policy = createTripPolicy(makePorts());

    expect(policy.debounceMs).toBe(0);
    expect(policy.maxWaitMs).toBe(0);
  });

  it("admits a new route, destination or profile, and nothing else until the refresh is due", () => {
    const policy = createTripPolicy(makePorts());

    expect(policy.admits(input, { ...input, route: { ...ROUTE } }, 0, 1)).toBe(
      true,
    );
    expect(policy.admits(input, { ...input, dest: FAR }, 0, 1)).toBe(true);
    expect(policy.admits(input, { ...input, profile: "walking" }, 0, 1)).toBe(
      true,
    );
    expect(
      policy.admits(input, { ...input, dest: { ...JERUSALEM } }, 0, 1),
    ).toBe(false);
  });

  // The server deletes the trip whenever the connection drops; a page that
  // reconnects has nothing new to write, so it is written again.
  it("admits the same trip again once the refresh is due", () => {
    const policy = createTripPolicy(makePorts());

    expect(policy.admits(input, input, 0, TRIP_REFRESH_MS)).toBe(true);
  });

  it("writes the trip under the claimed slot, with its line encoded", async () => {
    const ports = makePorts();
    const policy = createTripPolicy(ports);

    await policy.run(input, new AbortController().signal);

    expect(ports.writeTrip).toHaveBeenCalledWith(
      "ABC234",
      1,
      {
        lat: JERUSALEM.lat,
        lng: JERUSALEM.lng,
        profile: "driving",
        duration: 3_600,
        distance: 60_000,
        line: expect.any(String) as string,
      },
      expect.anything(),
    );
    const written = vi.mocked(ports.writeTrip).mock.calls[0]?.[2];
    expect(decodePolyline(written?.line ?? "")).toEqual(
      ROUTE.geometry.coordinates,
    );
  });

  it("reports a failed write", async () => {
    const policy = createTripPolicy(
      makePorts({
        writeTrip: vi
          .fn()
          .mockResolvedValue(err({ kind: "DENIED", detail: "denied" })),
      }),
    );

    const result = await policy.run(input, new AbortController().signal);

    expect(result.ok).toBe(false);
  });
});

describe("meet policy", () => {
  const input: MeetInput = {
    code: "ABC234",
    slot: 1,
    pin: { at: 1_000, by: 0, byName: null, position: TEL_AVIV, name: null },
  };

  // Set by a tap on Navigate, as the page goes to the background: a write
  // held back by a debounce would wait on a page the phone had suspended.
  it("writes at once, with no debounce", () => {
    const policy = createMeetPolicy(makePorts());

    expect(policy.debounceMs).toBe(0);
    expect(policy.maxWaitMs).toBe(0);
  });

  it("admits a new pin, and nothing else, until the refresh is due", () => {
    const policy = createMeetPolicy(makePorts());
    const moved = { ...input, pin: { ...input.pin, at: 2_000 } };
    const copy = { ...input, pin: { ...input.pin, position: { ...TEL_AVIV } } };

    expect(policy.admits(input, moved, 0, 1_000)).toBe(true);
    expect(policy.admits(input, copy, 0, 1_000)).toBe(false);
  });

  // The server deletes this copy whenever the connection drops; a page that
  // reconnects has nothing new to write, so the copy is written again.
  it("admits the same pin again once the refresh is due", () => {
    const policy = createMeetPolicy(makePorts());

    expect(policy.admits(input, input, 0, MEET_REFRESH_MS)).toBe(true);
  });

  it("writes the pin's fields under the claimed slot", async () => {
    const ports = makePorts();
    const policy = createMeetPolicy(ports);

    await policy.run(
      { ...input, pin: { ...input.pin, name: "Cafe" } },
      new AbortController().signal,
    );

    expect(ports.writeMeet).toHaveBeenCalledWith(
      "ABC234",
      1,
      {
        at: 1_000,
        by: 0,
        byName: null,
        lat: TEL_AVIV.lat,
        lng: TEL_AVIV.lng,
        name: "Cafe",
      },
      expect.anything(),
    );
  });

  it("reports a failed write", async () => {
    const policy = createMeetPolicy(
      makePorts({
        writeMeet: vi
          .fn()
          .mockResolvedValue(err({ kind: "DENIED", detail: "denied" })),
      }),
    );

    const result = await policy.run(input, new AbortController().signal);

    expect(result.ok).toBe(false);
  });
});

describe("routeAnswers", () => {
  const own = { dest: TEL_AVIV, profile: "driving" as const, route: null };

  it("holds while the destination stays inside the route threshold", () => {
    expect(routeAnswers(own, TEL_AVIV, "driving")).toBe(true);
    expect(routeAnswers(own, NEARBY, "driving")).toBe(true);
  });

  // Picking a venue moves the destination; the route to the old one would
  // list a time and distance to somewhere nobody is going.
  it("lapses once the destination moves beyond it", () => {
    expect(routeAnswers(own, FAR, "driving")).toBe(false);
  });

  it("lapses when the travel profile changes", () => {
    expect(routeAnswers(own, TEL_AVIV, "walking")).toBe(false);
  });
});

describe("tripAnswers", () => {
  // Each device asks again once its own destination moves 200 m, and the
  // live midpoint each computes is the same one a moment apart.
  it("holds for a trip to the same destination as this device sees it", () => {
    expect(tripAnswers(TEL_AVIV, TEL_AVIV)).toBe(true);
    expect(tripAnswers(TEL_AVIV, NEARBY)).toBe(true);
  });

  it("lapses for a trip to somewhere else", () => {
    expect(PEER_TRIP_ADMIT_M).toBeLessThan(1_000);
    expect(tripAnswers(TEL_AVIV, FAR)).toBe(false);
  });
});

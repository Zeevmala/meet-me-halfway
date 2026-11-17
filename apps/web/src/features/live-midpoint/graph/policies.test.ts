import { describe, it, expect, vi } from "vitest";
import {
  createMeetPolicy,
  createVenuePolicy,
  createRoutePolicy,
  MEET_REFRESH_MS,
  ROUTE_REFRESH_MS,
  ROUTE_RETRY_MS,
  routesAnswer,
} from "./policies";
import type { MeetInput, RouteInput, VenueInput } from "./policies";
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

  // `driving` and `walking` are not traffic-aware: asking the same question
  // every minute, as it did, got the same answer.
  it("admits a stationary refresh only once routes age past the refresh", () => {
    expect(policy.admits(base, base, 0, 60_000)).toBe(false);
    expect(policy.admits(base, base, 0, ROUTE_REFRESH_MS)).toBe(true);
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
    expect(result.value.bySlot[0]).toBeNull();
    expect(result.value.bySlot[1]?.distance).toBe(11);
    expect(result.value.bySlot[3]?.distance).toBe(22);
  });

  it("tags the routes with the destination and profile they answer", async () => {
    const p = createRoutePolicy(makePorts());
    const input = routeInput(
      [TEL_AVIV, null, null, null, null],
      FAR,
      "walking",
    );

    const result = await p.run(input, new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dest).toEqual(FAR);
    expect(result.value.profile).toBe("walking");
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
    expect(result.value.bySlot[0]).toBeNull();
    expect(result.value.bySlot[1]?.distance).toBe(22);
  });

  describe("asks only for the routes that no longer answer", () => {
    function route(distance: number) {
      return ok({
        geometry: { type: "LineString" as const, coordinates: [] },
        duration: distance / 10,
        distance,
      });
    }
    /** A policy on a clock the test moves, fetching routes it counts. */
    function counting() {
      let nowMs = 0;
      let next = 0;
      const fetchRoute = vi.fn().mockImplementation(async () => route(++next));
      const p = createRoutePolicy(makePorts({ fetchRoute, now: () => nowMs }));
      const run = (input: RouteInput) =>
        p.run(input, new AbortController().signal);
      return { fetchRoute, run, tick: (ms: number) => (nowMs += ms) };
    }

    // One person walking 200 m cost a request per participant on every
    // device: five devices, five people, twenty-five requests for one move.
    it("fetches again only the route of whoever moved", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, JERUSALEM, NEARBY, null, null], FAR));
      expect(c.fetchRoute).toHaveBeenCalledTimes(3);

      const moved = await c.run(
        routeInput([TEL_AVIV, FAR, NEARBY, null, null], FAR),
      );

      expect(c.fetchRoute).toHaveBeenCalledTimes(4);
      expect(c.fetchRoute.mock.calls[3][0]).toEqual(FAR);
      expect(moved.ok && moved.value.bySlot.map((r) => r?.distance)).toEqual([
        1,
        4,
        3,
        undefined,
        undefined,
      ]);
    });

    it("fetches every route again when the destination moves", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR));

      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], NEARBY));

      expect(c.fetchRoute).toHaveBeenCalledTimes(4);
    });

    it("fetches every route again for another profile", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR));

      await c.run(
        routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR, "walking"),
      );

      expect(c.fetchRoute).toHaveBeenCalledTimes(4);
    });

    it("fetches a route again once it is older than the refresh", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, null, null, null, null], FAR));

      c.tick(ROUTE_REFRESH_MS - 1);
      await c.run(routeInput([TEL_AVIV, null, null, null, null], FAR));
      expect(c.fetchRoute).toHaveBeenCalledTimes(1);

      c.tick(1);
      await c.run(routeInput([TEL_AVIV, null, null, null, null], FAR));
      expect(c.fetchRoute).toHaveBeenCalledTimes(2);
    });

    // Checked per route: a destination drifting under 200 m at a time would
    // otherwise carry kept routes ever further from where they lead.
    it("does not keep a route whose destination has drifted step by step", async () => {
      const c = counting();
      const step1 = { lat: TEL_AVIV.lat + 0.0013, lng: TEL_AVIV.lng }; // ~145 m
      const step2 = { lat: TEL_AVIV.lat + 0.0026, lng: TEL_AVIV.lng }; // ~290 m
      await c.run(routeInput([JERUSALEM, null, null, null, null], TEL_AVIV));

      await c.run(routeInput([JERUSALEM, null, null, null, null], step1));
      expect(c.fetchRoute).toHaveBeenCalledTimes(1);

      await c.run(routeInput([JERUSALEM, null, null, null, null], step2));
      expect(c.fetchRoute).toHaveBeenCalledTimes(2);
    });

    it("forgets the route of a slot that empties", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR));
      await c.run(routeInput([TEL_AVIV, null, null, null, null], FAR));

      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR));

      expect(c.fetchRoute).toHaveBeenCalledTimes(3);
    });

    // Nothing was asked, so nothing failed.
    it("answers with the kept routes when none needs fetching", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, null, null, null, null], FAR));
      c.fetchRoute.mockResolvedValue(
        err({ kind: "RATE_LIMITED", retryAfterMs: 0 }),
      );

      const again = await c.run(
        routeInput([TEL_AVIV, null, null, null, null], FAR),
      );

      expect(again.ok).toBe(true);
    });

    // A failed route does not fail the set, so nothing else would ask again
    // until somebody moved, or the refresh five minutes on.
    it("asks again within a minute once a route has failed, and then only for it", async () => {
      let nowMs = 0;
      const fetchRoute = vi
        .fn()
        .mockResolvedValueOnce(route(1))
        .mockResolvedValueOnce(err({ kind: "NETWORK", detail: "reset" }))
        .mockResolvedValue(route(3));
      const p = createRoutePolicy(makePorts({ fetchRoute, now: () => nowMs }));
      const input = routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR);
      await p.run(input, new AbortController().signal);

      expect(p.admits(input, input, 0, ROUTE_RETRY_MS - 1)).toBe(false);
      expect(p.admits(input, input, 0, ROUTE_RETRY_MS)).toBe(true);

      nowMs = ROUTE_RETRY_MS;
      const retried = await p.run(input, new AbortController().signal);
      expect(fetchRoute).toHaveBeenCalledTimes(3);
      expect(fetchRoute.mock.calls[2][0]).toEqual(JERUSALEM);
      expect(retried.ok && retried.value.bySlot[1]?.distance).toBe(3);
      // Answered: back to the refresh.
      expect(p.admits(input, input, 0, ROUTE_RETRY_MS)).toBe(false);
    });

    // Keeping one route is not an answer for a participant whose route failed.
    it("does not count a kept route as an answer for a failed one", async () => {
      const c = counting();
      await c.run(routeInput([TEL_AVIV, JERUSALEM, null, null, null], FAR));
      c.fetchRoute.mockResolvedValue(
        err({ kind: "RATE_LIMITED", retryAfterMs: 0 }),
      );

      const moved = await c.run(
        routeInput([TEL_AVIV, NEARBY, null, null, null], FAR),
      );

      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.value.bySlot[0]?.distance).toBe(1);
      expect(moved.value.bySlot[1]).toBeNull();
    });
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

describe("routesAnswer", () => {
  const set = {
    dest: TEL_AVIV,
    profile: "driving" as const,
    bySlot: [null, null, null, null, null],
  };

  it("holds while the destination stays inside the route threshold", () => {
    expect(routesAnswer(set, TEL_AVIV, "driving")).toBe(true);
    expect(routesAnswer(set, NEARBY, "driving")).toBe(true);
  });

  // Picking a venue moves the destination; the routes to the old one would
  // list times and distances to somewhere nobody is going.
  it("lapses once the destination moves beyond it", () => {
    expect(routesAnswer(set, FAR, "driving")).toBe(false);
  });

  it("lapses when the travel profile changes", () => {
    expect(routesAnswer(set, TEL_AVIV, "walking")).toBe(false);
  });
});

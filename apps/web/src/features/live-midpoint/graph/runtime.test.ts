import { describe, it, expect, vi } from "vitest";
import { createRuntime } from "./runtime";
import type { GraphPorts } from "./ports";
import type { RouteInfo } from "./types";
import type { LatLng } from "../lib/geo-math";
import type { PlaceResult } from "../lib/venue-ranking";
import { ok } from "../../../core/dag/result";
import type { TimerId } from "../../../core/dag/resource";

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };

function route(distance: number): RouteInfo {
  return {
    geometry: { type: "LineString", coordinates: [] },
    duration: distance / 10,
    distance,
  };
}

const PLACES: PlaceResult[] = [
  {
    id: "v1",
    displayName: "Cafe One",
    location: { lat: 31.93, lng: 35.0 },
    rating: 4.5,
    userRatingCount: 100,
    openNow: true,
    types: ["cafe"],
  },
  {
    id: "v2",
    displayName: "Bar Two",
    location: { lat: 31.94, lng: 35.01 },
    rating: 4.0,
    userRatingCount: 50,
    openNow: true,
    types: ["bar"],
  },
];

function createHarness(overrides: Partial<GraphPorts> = {}) {
  let nowMs = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };

  const ports: GraphPorts = {
    now: () => nowMs,
    schedule: (fn, ms) => {
      const id = ++nextId;
      tasks.set(id, { at: nowMs + ms, fn });
      return id as unknown as TimerId;
    },
    cancel: (id) => {
      tasks.delete(id as unknown as number);
    },
    searchVenues: vi.fn().mockResolvedValue(ok(PLACES)),
    fetchRoute: vi.fn().mockResolvedValue(ok(route(1000))),
    placesEnabled: true,
    ...overrides,
  };

  const advance = async (ms: number): Promise<void> => {
    const target = nowMs + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueId = id;
          dueAt = task.at;
        }
      }
      if (dueId === null) break;
      const task = tasks.get(dueId);
      tasks.delete(dueId);
      nowMs = dueAt;
      task?.fn();
      await flush();
    }
    nowMs = target;
    await flush();
  };

  return { ports, advance, flush };
}

describe("createRuntime", () => {
  it("returns a referentially stable snapshot while nothing changes", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    expect(r.getSnapshot()).toBe(r.getSnapshot());
  });

  it("ignores a patch whose values are unchanged", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, { travelProfile: "driving" });
    const listener = vi.fn();
    r.subscribe(listener);

    r.setSources({ travelProfile: "driving" });

    expect(listener).not.toHaveBeenCalled();
    expect(r.getSnapshot()).toBe(r.getSnapshot());
  });

  it("emits one notification for a patch touching several sources", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);
    const listener = vi.fn();
    r.subscribe(listener);

    r.setSources({
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      ownAccuracy: 5,
      travelProfile: "walking",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(r.getSnapshot().travelProfile).toBe("walking");
  });

  // RTDB hands over a fresh participants array on every heartbeat. Without
  // element-wise comparison each one would allocate a new SlotVector and
  // invalidate the entire graph, re-rendering the map on every tick.
  it("reuses the slot vector when an equal roster arrives again", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, { ownSlot: 0, ownPosition: TEL_AVIV });

    const before = r.getSnapshot().slots;
    r.setSources({
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });
    const withPeer = r.getSnapshot().slots;
    expect(withPeer).not.toBe(before);

    // Same values, brand new array and objects.
    r.setSources({
      participants: [
        {
          index: 1,
          position: { ...JERUSALEM },
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    expect(r.getSnapshot().slots).toBe(withPeer);
  });

  it("computes a midpoint once two slots are occupied", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, { ownSlot: 0, ownPosition: TEL_AVIV });

    expect(r.getSnapshot().midpoint).toBeNull();

    r.setSources({
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    expect(r.getSnapshot().midpoint).not.toBeNull();
  });

  it("searches venues and ranks them once a midpoint exists", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    await h.advance(15_000);

    expect(h.ports.searchVenues).toHaveBeenCalled();
    expect(r.getSnapshot().venues.length).toBeGreaterThan(0);
  });

  it("never searches venues when the feature is disabled", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    await h.advance(20_000);

    expect(h.ports.searchVenues).not.toHaveBeenCalled();
    expect(r.getSnapshot().venues).toEqual([]);
  });

  it("routes every occupied slot to the midpoint by default", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 2,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 4,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    await h.advance(10_000);

    expect(h.ports.fetchRoute).toHaveBeenCalledTimes(2);
    const snapshot = r.getSnapshot();
    expect(snapshot.routes[2]).not.toBeNull();
    expect(snapshot.routes[4]).not.toBeNull();
    expect(snapshot.routes[0]).toBeNull();
    expect(snapshot.routes[1]).toBeNull();
  });

  it("routes to a selected venue instead of the midpoint", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });
    await h.advance(15_000);

    r.setSources({ selectedVenueId: "v1" });
    await h.advance(10_000);

    expect(r.getSnapshot().selectedVenue?.id).toBe("v1");
    expect(r.getSnapshot().destination).toEqual({ lat: 31.93, lng: 35.0 });
  });

  // Regression: the old reconciliation effect only ran when venues.length > 0,
  // so an empty result left a stale selection pinned as the destination.
  it("falls back to the midpoint when the selected venue vanishes", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });
    await h.advance(15_000);
    r.setSources({ selectedVenueId: "v1" });
    await h.advance(10_000);
    expect(r.getSnapshot().selectedVenue?.id).toBe("v1");

    // A later search comes back empty.
    (h.ports.searchVenues as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok([]),
    );
    r.setSources({ ownPosition: { lat: 32.5, lng: 34.9 } });
    await h.advance(60_000);

    const snapshot = r.getSnapshot();
    expect(snapshot.venues).toEqual([]);
    expect(snapshot.selectedVenue).toBeNull();
    expect(snapshot.destination).toEqual(snapshot.midpoint);
  });

  it("stops scheduling work once disposed", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [
        {
          index: 1,
          position: JERUSALEM,
          accuracy: 10,
          stale: false,
          name: null,
        },
      ],
    });

    r.dispose();
    expect(r.isDisposed()).toBe(true);

    await h.advance(30_000);
    expect(h.ports.fetchRoute).not.toHaveBeenCalled();
  });
});

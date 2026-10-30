import { describe, it, expect, vi } from "vitest";
import { createRuntime } from "./runtime";
import { DEPARTED_THRESHOLD_MS, STALE_THRESHOLD_MS } from "./nodes";
import { PRESENCE_HEARTBEAT_MS } from "./policies";
import type { GraphPorts } from "./ports";
import type { ParticipantSource, RouteInfo } from "./types";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
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

/**
 * A peer as the session layer reports them.
 *
 * `lastSeen` is the field the graph actually consumes: staleness is derived as
 * `now - lastSeen > STALE_THRESHOLD_MS` and never stored. These fixtures used
 * to carry a boolean staleness flag that `ParticipantSource` does not declare
 * — with `lastSeen` therefore absent, the subtraction was `NaN`, every
 * comparison was false, and each case silently exercised only the fresh
 * branch. The harness clock starts at 0, so defaulting `lastSeen` to 0
 * reproduces that intent, honestly this time.
 */
function peer(
  index: ParticipantIndex,
  position: LatLng,
  lastSeen = 0,
): ParticipantSource {
  return { index, position, accuracy: 10, lastSeen, name: null };
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
    writePresence: vi.fn().mockResolvedValue(ok(undefined)),
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

  return { ports, advance, flush, now: () => nowMs, pending: () => tasks.size };
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
      participants: [peer(1, JERUSALEM)],
    });
    const withPeer = r.getSnapshot().slots;
    expect(withPeer).not.toBe(before);

    // Same values, brand new array and objects.
    r.setSources({
      participants: [peer(1, { ...JERUSALEM })],
    });

    expect(r.getSnapshot().slots).toBe(withPeer);
  });

  it("computes a midpoint once two slots are occupied", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, { ownSlot: 0, ownPosition: TEL_AVIV });

    expect(r.getSnapshot().midpoint).toBeNull();

    r.setSources({
      participants: [peer(1, JERUSALEM)],
    });

    expect(r.getSnapshot().midpoint).not.toBeNull();
  });

  it("searches venues and ranks them once a midpoint exists", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
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
      participants: [peer(1, JERUSALEM)],
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
      participants: [peer(4, JERUSALEM)],
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
      participants: [peer(1, JERUSALEM)],
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
      participants: [peer(1, JERUSALEM)],
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
      participants: [peer(1, JERUSALEM)],
    });

    r.dispose();
    expect(r.isDisposed()).toBe(true);

    await h.advance(30_000);
    expect(h.ports.fetchRoute).not.toHaveBeenCalled();
  });
});

describe("createRuntime — presence", () => {
  /** Everything the presence node needs before it will write anything. */
  function ready(overrides: Record<string, unknown> = {}) {
    return {
      sessionCode: "ABC234",
      ownUid: "own-uid",
      ownSlot: 0 as const,
      ownPosition: TEL_AVIV,
      ownAccuracy: 12,
      ownName: "Me",
      sessionStatus: "ready" as const,
      ...overrides,
    };
  }

  it("does not write until code, uid and position all exist", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({ sessionCode: "ABC234", ownUid: "own-uid" });
    await h.advance(10_000);
    expect(h.ports.writePresence).not.toHaveBeenCalled();

    r.setSources({ ownSlot: 0, ownPosition: TEL_AVIV, ownAccuracy: 12 });
    await h.advance(10_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("writes once the code arrives after the position", async () => {
    // The old hook needed a dedicated "flush once the code is set" effect for
    // this: a stationary joiner's single GPS fix could land before the async
    // join resolved and then never be written at all, so peers never saw them.
    // Here the input simply becomes non-null and the resource fires.
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({ ownSlot: 0, ownPosition: TEL_AVIV, ownAccuracy: 12 });
    await h.advance(10_000);
    expect(h.ports.writePresence).not.toHaveBeenCalled();

    r.setSources({ sessionCode: "ABC234", ownUid: "own-uid" });
    await h.advance(10_000);

    // Keyed by the claimed slot; the uid rides in the payload, where the
    // rules validate it against auth.uid.
    expect(h.ports.writePresence).toHaveBeenCalledWith(
      "ABC234",
      0,
      expect.objectContaining({
        uid: "own-uid",
        lat: TEL_AVIV.lat,
        lng: TEL_AVIV.lng,
        accuracy: 12,
      }),
      expect.anything(),
    );
    r.dispose();
  });

  it("throttles a burst of fixes to one write per window", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);

    // Ten fixes inside one window, each a metre or so apart.
    for (let i = 1; i <= 10; i++) {
      r.setSources({
        ownPosition: { lat: TEL_AVIV.lat + i * 0.00001, lng: TEL_AVIV.lng },
      });
      await h.advance(100);
    }

    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("admits the next fix once the window has elapsed, however small the move", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);

    // A metre of GPS noise is well under PRESENCE_ADMIT_M, so this is admitted
    // purely by age — which is what keeps a stationary participant's write
    // fresh enough that peers do not start showing them as stale.
    await h.advance(4_000);
    r.setSources({
      ownPosition: { lat: TEL_AVIV.lat + 0.00001, lng: TEL_AVIV.lng },
    });
    await h.advance(3_000);

    expect(h.ports.writePresence).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  // This used to be the documented limitation: presence wrote only when
  // something else ticked the graph, so with GPS quiet and no peer moving a
  // participant wrote once and then not again, and every peer showed them as
  // stale after STALE_THRESHOLD_MS.
  it("keeps writing while standing still, so peers do not see it go stale", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);

    await h.advance(60_000);
    expect(
      vi.mocked(h.ports.writePresence).mock.calls.length,
    ).toBeGreaterThanOrEqual(1 + 60_000 / PRESENCE_HEARTBEAT_MS - 1);
    r.dispose();
  });

  it("stops the heartbeat once there is nothing to publish", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(ready());
    await h.advance(3_000);

    // A denied permission clears the position.
    r.setSources({ ownPosition: null });
    const writes = vi.mocked(h.ports.writePresence).mock.calls.length;
    await h.advance(60_000);

    expect(h.ports.writePresence).toHaveBeenCalledTimes(writes);
    expect(h.pending()).toBe(0);
    r.dispose();
  });

  it("admits a name change immediately", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    const before = (h.ports.writePresence as ReturnType<typeof vi.fn>).mock
      .calls.length;

    r.setSources({ ownName: "Dana" });
    await h.advance(3_000);

    const calls = (h.ports.writePresence as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls.length).toBeGreaterThan(before);
    expect(calls[calls.length - 1][2]).toMatchObject({ name: "Dana" });
    r.dispose();
  });

  it("reports a failed write instead of degrading to a stale value", async () => {
    // A write has nothing to serve, so there is nothing to degrade *to*: the
    // honest answer is that our location is not reaching anyone.
    const h = createHarness({
      writePresence: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: "NETWORK", detail: "x" },
      }),
    });
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(30_000);

    expect(r.getSnapshot().presenceFailed).toBe(true);
    r.dispose();
  });

  it("stops writing once disposed", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    const before = (h.ports.writePresence as ReturnType<typeof vi.fn>).mock
      .calls.length;

    r.dispose();
    await h.advance(30_000);

    expect(
      (h.ports.writePresence as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(before);
  });
});

describe("createRuntime — liveness", () => {
  const peer = (lastSeen: number) => ({
    index: 1 as const,
    position: JERUSALEM,
    accuracy: 10,
    lastSeen,
    name: "Peer",
  });

  it("derives the phase rather than being told it", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    expect(r.getSnapshot().phase).toBe("idle");

    r.setSources({ sessionStatus: "connecting" });
    expect(r.getSnapshot().phase).toBe("creating");

    r.setSources({
      sessionStatus: "ready",
      ownSlot: 0,
      ownPosition: TEL_AVIV,
    });
    expect(r.getSnapshot().phase).toBe("waiting");

    r.setSources({ participants: [peer(h.now())] });
    expect(r.getSnapshot().phase).toBe("connected");
    r.dispose();
  });

  it("flips a peer to stale on its own schedule, with no polling", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({
      sessionStatus: "ready",
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [peer(h.now())],
    });
    expect(r.getSnapshot().phase).toBe("connected");

    await h.advance(29_000);
    expect(r.getSnapshot().phase).toBe("connected");

    // One armed wake at lastSeen + 30s, not a 10s interval running all session.
    await h.advance(2_000);
    expect(r.getSnapshot().phase).toBe("some_stale");
    expect(r.getSnapshot().slots.stale[1]).toBe(true);
    r.dispose();
  });

  it("arms a wake for departure once a peer has gone stale", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);

    r.setSources({
      sessionStatus: "ready",
      participants: [peer(h.now() - 60_000)],
    });
    await h.advance(1_000);
    expect(r.getSnapshot().slots.stale[1]).toBe(true);
    expect(r.getSnapshot().slots.departed[1]).toBe(false);

    await h.advance(DEPARTED_THRESHOLD_MS);
    expect(r.getSnapshot().slots.departed[1]).toBe(true);
    r.dispose();
  });

  it("arms nothing further once every peer has departed", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);

    r.setSources({
      sessionStatus: "ready",
      participants: [peer(h.now() - DEPARTED_THRESHOLD_MS)],
    });
    await h.advance(1_000);

    expect(r.getSnapshot().slots.departed[1]).toBe(true);
    expect(h.pending()).toBe(0);
    r.dispose();
  });

  // `lastSeen` is stamped by the server, so it is compared with server time.
  it("judges staleness against server time, not this device's clock", () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    // This device runs two minutes fast, and the peer has just written.
    const serverNowMs = h.now() - 120_000;

    r.setSources({
      sessionStatus: "ready",
      participants: [peer(serverNowMs)],
      serverTimeOffsetMs: -120_000,
    });
    expect(r.getSnapshot().slots.stale[1]).toBe(false);

    // Measured against the device's clock alone, the same write is two
    // minutes old: the peer would have been dropped from the midpoint.
    r.setSources({ serverTimeOffsetMs: 0 });
    expect(r.getSnapshot().slots.departed[1]).toBe(true);
    r.dispose();
  });

  // RTDB reports the offset after connecting, typically once the wake for the
  // next flip is already armed — and the flip's server time is unchanged by
  // it. Kept, that wake ran on the old offset: a phone three minutes slow
  // marked a peer who stopped writing stale three minutes late.
  it("re-arms the liveness wake when the server offset is re-measured", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources({ sessionStatus: "ready", participants: [peer(h.now())] });

    // The server is 20s ahead: the peer's write is already 20s old.
    r.setSources({ serverTimeOffsetMs: 20_000 });
    expect(r.getSnapshot().slots.stale[1]).toBe(false);

    await h.advance(STALE_THRESHOLD_MS - 20_000);
    expect(r.getSnapshot().slots.stale[1]).toBe(true);
    r.dispose();
  });

  it("reuses the slot vector across a heartbeat that moves nothing", async () => {
    // Staleness is a boolean in the vector, not a raw lastSeen, precisely so a
    // stationary participant's heartbeat is not a change. Losing this would
    // hand LiveMap a new array every three seconds.
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({
      sessionStatus: "ready",
      ownSlot: 0,
      ownPosition: TEL_AVIV,
      participants: [peer(h.now())],
    });
    const before = r.getSnapshot().slots;

    r.setSources({ participants: [peer(h.now() + 3_000)] });

    expect(r.getSnapshot().slots).toBe(before);
    r.dispose();
  });

  it("cancels the liveness wake on dispose", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);

    r.setSources({ sessionStatus: "ready", participants: [peer(h.now())] });
    expect(h.pending()).toBeGreaterThan(0);

    r.dispose();
    expect(h.pending()).toBe(0);
  });
});

describe("createRuntime — departed peers and stale routes", () => {
  function session(
    participants: ParticipantSource[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      sessionCode: "ABC234",
      ownUid: "own-uid",
      ownSlot: 0 as const,
      ownPosition: TEL_AVIV,
      ownAccuracy: 10,
      ownName: "Me",
      sessionStatus: "ready" as const,
      participants,
      ...overrides,
    };
  }

  // After the only peer left, the midpoint went null but the last route set
  // stayed on the map and in the card, with nothing left to replace it.
  it("drops every route when the last peer leaves", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(session([peer(1, JERUSALEM, h.now())]));
    await h.advance(10_000);
    expect(r.getSnapshot().routes.filter(Boolean)).toHaveLength(2);

    r.setSources({ participants: [] });

    expect(r.getSnapshot().midpoint).toBeNull();
    expect(r.getSnapshot().routes.filter(Boolean)).toHaveLength(0);
    r.dispose();
  });

  // A peer silent for minutes kept pulling the midpoint towards where they
  // were last seen, and kept a route.
  it("stops counting a departed peer toward the midpoint and routes", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(session([peer(1, JERUSALEM, h.now())]));
    await h.advance(10_000);
    expect(r.getSnapshot().midpoint).not.toBeNull();

    await h.advance(DEPARTED_THRESHOLD_MS);

    const snapshot = r.getSnapshot();
    expect(snapshot.slots.departed[1]).toBe(true);
    expect(snapshot.slots.positions[1]).toEqual(JERUSALEM); // still drawn
    expect(snapshot.midpoint).toBeNull();
    expect(snapshot.routes[1]).toBeNull();
    expect(snapshot.phase).toBe("waiting");
    r.dispose();
  });

  // Routes answer one destination. Picking a venue moved it, and the card went
  // on listing times and distances to the midpoint until the new fetch landed.
  it("hides routes fetched for a previous destination until new ones arrive", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);
    r.setSources(session([peer(1, JERUSALEM, h.now())]));
    // The venue search's maxWait, as in "routes to a selected venue": every
    // tick re-offers its input, so its trailing debounce alone never fires.
    await h.advance(15_000);
    expect(r.getSnapshot().routes.filter(Boolean).length).toBeGreaterThan(0);

    r.setSources({ selectedVenueId: "v1" });
    expect(r.getSnapshot().destination).toEqual(PLACES[0]?.location);
    expect(r.getSnapshot().routes.filter(Boolean)).toHaveLength(0);

    await h.advance(10_000);
    expect(r.getSnapshot().routes.filter(Boolean).length).toBeGreaterThan(0);
    r.dispose();
  });
});

import { describe, it, expect, vi } from "vitest";
import { createRuntime } from "./runtime";
import {
  DEPARTED_THRESHOLD_MS,
  SESSION_TTL_MS,
  STALE_THRESHOLD_MS,
} from "./nodes";
import { PRESENCE_HEARTBEAT_MS } from "./policies";
import type { GraphPorts } from "./ports";
import type {
  ParticipantSource,
  PeerTrip,
  RouteInfo,
  SessionLifecycle,
} from "./types";
import { encodePolyline } from "../lib/polyline";
import { geographicCentroid } from "../lib/geo-math";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { PlaceResult } from "../lib/venue-ranking";
import { ok, err } from "../../../core/dag/result";
import type { TimerId } from "../../../core/dag/resource";

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };

/**
 * A live session holding slot 0, created at the harness clock's epoch — so
 * it expires at `SESSION_TTL_MS`, and the runtime keeps one wake armed for
 * that instant for as long as it is live.
 */
const LIVE: SessionLifecycle = {
  kind: "live",
  code: "ABC234",
  slot: 0,
  createdAtMs: 0,
};

function route(distance: number): RouteInfo {
  return {
    geometry: { type: "LineString", coordinates: [] },
    duration: distance / 10,
    distance,
  };
}

/**
 * By slot: `slot`'s trip, as its device would publish it, to `dest`. The
 * line is a real encoded one: the runtime decodes it to draw it.
 */
function tripsFor(
  slot: ParticipantIndex,
  dest: LatLng,
  profile: "driving" | "walking" = "walking",
): (PeerTrip | null)[] {
  const trips: (PeerTrip | null)[] = [null, null, null, null, null];
  trips[slot] = {
    dest,
    profile,
    duration: 900,
    distance: 9_000,
    line: encodePolyline([
      [JERUSALEM.lng, JERUSALEM.lat],
      [dest.lng, dest.lat],
    ]),
  };
  return trips;
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
    removePresence: vi.fn(),
    writeMeet: vi.fn().mockResolvedValue(ok(undefined)),
    removeMeet: vi.fn(),
    writeTrip: vi.fn().mockResolvedValue(ok(undefined)),
    removeTrip: vi.fn(),
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

  return {
    ports,
    advance,
    flush,
    now: () => nowMs,
    pending: () => tasks.size,
    /**
     * Timers due before `atMs`. A live session always keeps one wake armed
     * for its expiry; asking about everything before it is how a test says
     * "nothing else is scheduled".
     */
    pendingBefore: (atMs: number) =>
      [...tasks.values()].filter((task) => task.at < atMs).length,
  };
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
      session: LIVE,
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
    const r = createRuntime(h.ports, { session: LIVE, ownPosition: TEL_AVIV });

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
    const r = createRuntime(h.ports, { session: LIVE, ownPosition: TEL_AVIV });

    expect(r.getSnapshot().midpoint).toBeNull();

    r.setSources({
      participants: [peer(1, JERUSALEM)],
    });

    expect(r.getSnapshot().midpoint).not.toBeNull();
  });

  it("searches venues and ranks them once a midpoint exists", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
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
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });

    await h.advance(20_000);

    expect(h.ports.searchVenues).not.toHaveBeenCalled();
    expect(r.getSnapshot().venues).toEqual([]);
  });

  // Each device routes its own trip and publishes it; everyone else's comes
  // from what their devices published. Every device used to route everyone:
  // five people, twenty-five requests to Mapbox for one person's move.
  it("routes this device alone, and shows the trips the others publish", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: { ...LIVE, slot: 2 },
      ownPosition: TEL_AVIV,
      participants: [peer(4, JERUSALEM)],
    });

    await h.advance(10_000);

    expect(h.ports.fetchRoute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.ports.fetchRoute).mock.calls[0]?.[0]).toEqual(TEL_AVIV);
    expect(r.getSnapshot().routes[2]).not.toBeNull();
    expect(r.getSnapshot().routes[4]).toBeNull();

    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    r.setSources({ peerTrips: tripsFor(4, midpoint) });

    const snapshot = r.getSnapshot();
    expect(snapshot.routes[4]).toMatchObject({
      duration: 900,
      distance: 9_000,
      geometry: { type: "LineString" },
    });
    // Decoded from the published line, to its metre precision.
    const [start, end] = snapshot.routes[4]?.geometry.coordinates ?? [];
    expect(start).toEqual([JERUSALEM.lng, JERUSALEM.lat]);
    expect(end?.[0]).toBeCloseTo(midpoint.lng, 5);
    expect(end?.[1]).toBeCloseTo(midpoint.lat, 5);
    expect(snapshot.routeProfiles[4]).toBe("walking");
    expect(snapshot.routeProfiles[2]).toBe("driving");
    expect(snapshot.routes[0]).toBeNull();
    expect(snapshot.routes[1]).toBeNull();
    expect(h.ports.fetchRoute).toHaveBeenCalledTimes(1);
  });

  // The midpoint each device computes is the same one a moment apart, and
  // each asks for its route again once its destination moves 200 m.
  it("shows a trip only while it goes where this device is going", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");

    r.setSources({
      peerTrips: tripsFor(1, { lat: midpoint.lat + 0.002, lng: midpoint.lng }),
    });
    expect(r.getSnapshot().routes[1]).not.toBeNull();

    r.setSources({
      peerTrips: tripsFor(1, { lat: midpoint.lat + 0.02, lng: midpoint.lng }),
    });
    expect(r.getSnapshot().routes[1]).toBeNull();
    r.dispose();
  });

  it("keeps a peer's route, and the snapshot, while the same trip arrives again", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    r.setSources({ peerTrips: tripsFor(1, midpoint) });
    const before = r.getSnapshot();

    r.setSources({ peerTrips: tripsFor(1, midpoint) });

    expect(r.getSnapshot()).toBe(before);
    r.dispose();
  });

  // The line is another device's: the rules check its alphabet, not that it
  // decodes. A trip whose line does not decode is no route.
  it("draws no route from a trip whose line does not decode", () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    const trips = tripsFor(1, midpoint);
    const broken = trips[1];
    if (!broken) throw new Error("no trip");
    trips[1] = { ...broken, line: "~~~~" };

    r.setSources({ peerTrips: trips });

    expect(r.getSnapshot().routes[1]).toBeNull();
    expect(r.getSnapshot().routeProfiles[1]).toBeNull();
    r.dispose();
  });

  // Regression: every tick re-offers every node its input, and each offer
  // restarted the trailing debounce. Under a GPS reporting once a second the
  // first routes came at the ceiling, 9 s, not 3 s, and the first venue
  // search at 15 s, not 5 s.
  it("fetches on its debounce, not its ceiling, under a once-a-second GPS", async () => {
    const h = createHarness();
    let firstRouteAt = -1;
    let firstSearchAt = -1;
    vi.mocked(h.ports.fetchRoute).mockImplementation(async () => {
      if (firstRouteAt < 0) firstRouteAt = h.now();
      return ok(route(1000));
    });
    vi.mocked(h.ports.searchVenues).mockImplementation(async () => {
      if (firstSearchAt < 0) firstSearchAt = h.now();
      return ok(PLACES);
    });
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });

    for (let second = 0; second < 20; second++) {
      await h.advance(1_000);
      // The same fix again: same coordinates, a new object, as every report.
      r.setSources({ ownPosition: { ...TEL_AVIV } });
    }

    expect(firstRouteAt).toBe(3_000);
    expect(firstSearchAt).toBe(5_000);
    r.dispose();
  });

  it("routes to a picked venue instead of the midpoint", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    await h.advance(5_000);

    r.setSources({ selectedPlace: PLACES[0] ?? null });
    await h.advance(10_000);

    expect(r.getSnapshot().selectedVenue?.id).toBe("v1");
    expect(r.getSnapshot().destination).toEqual({ lat: 31.93, lng: 35.0 });
  });

  // The pick used to be an id looked up in the latest results, so a search
  // around a moved midpoint that no longer returned it dropped it — and one
  // that returned it again brought it back. It is pinned now: listed, so it
  // can be seen and cleared, and the destination until it is. (Before the
  // lookup, an empty search left it the destination while the list showed
  // nothing at all.)
  it("keeps a picked venue listed, and the destination, once a search stops returning it", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    await h.advance(5_000);
    r.setSources({ selectedPlace: PLACES[0] ?? null });
    await h.advance(10_000);

    // A later search, around a moved midpoint, comes back empty.
    vi.mocked(h.ports.searchVenues).mockResolvedValue(ok([]));
    r.setSources({ ownPosition: { lat: 32.5, lng: 34.9 } });
    await h.advance(60_000);

    const kept = r.getSnapshot();
    expect(kept.venues.map((venue) => venue.id)).toEqual(["v1"]);
    expect(kept.selectedVenue?.id).toBe("v1");
    expect(kept.destination).toEqual({ lat: 31.93, lng: 35.0 });

    r.setSources({ selectedPlace: null });

    const cleared = r.getSnapshot();
    expect(cleared.venues).toEqual([]);
    expect(cleared.selectedVenue).toBeNull();
    expect(cleared.destination).toEqual(cleared.midpoint);
    r.dispose();
  });

  it("stops scheduling work once disposed", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, {
      session: LIVE,
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
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 12,
      ownName: "Me",
      ...overrides,
    };
  }

  it("does not write until the session is live", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({
      session: { kind: "joining" },
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 12,
    });
    await h.advance(10_000);
    expect(h.ports.writePresence).not.toHaveBeenCalled();

    r.setSources({ session: LIVE });
    await h.advance(10_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("writes once the session arrives after the position", async () => {
    // The old hook needed a dedicated "flush once the code is set" effect for
    // this: a stationary joiner's single GPS fix could land before the async
    // join resolved and then never be written at all, so peers never saw them.
    // Here the input simply becomes non-null and the resource fires.
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setSources({ ownPosition: TEL_AVIV, ownAccuracy: 12 });
    await h.advance(10_000);
    expect(h.ports.writePresence).not.toHaveBeenCalled();

    r.setSources({ session: LIVE, ownUid: "own-uid" });
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
    // Only the session's own expiry is left to wake for.
    expect(h.pendingBefore(SESSION_TTL_MS)).toBe(0);
    r.dispose();
  });

  // Regression: clearing the position stopped the next write but not the one
  // in flight, whose retry loop then put the position back — after the page
  // had removed it. privacy.html promises that turning location off deletes
  // it.
  it("does not let a write in flight retry once location is turned off", async () => {
    const h = createHarness({
      placesEnabled: false,
      writePresence: vi
        .fn()
        .mockResolvedValueOnce(err({ kind: "NETWORK", detail: "blip" }))
        .mockResolvedValue(ok(undefined)),
    });
    const r = createRuntime(h.ports);

    r.setSources(ready());
    await h.advance(3_000);
    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);

    // The write failed and is backing off before its retry when the denial
    // clears the position.
    r.setSources({ ownPosition: null, ownAccuracy: null });
    await h.advance(60_000);

    expect(h.ports.writePresence).toHaveBeenCalledTimes(1);
    expect(h.pendingBefore(SESSION_TTL_MS)).toBe(0);
    r.dispose();
  });

  // One owner: the node that writes own position is the one that deletes it,
  // however publishing stops. The deletion used to be the session hook's,
  // and a write still retrying in the graph put the position back.
  it("removes own position when location is turned off", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(ready());
    await h.advance(3_000);
    expect(h.ports.removePresence).not.toHaveBeenCalled();

    r.setSources({ ownPosition: null, ownAccuracy: null });

    expect(h.ports.removePresence).toHaveBeenCalledTimes(1);
    expect(h.ports.removePresence).toHaveBeenCalledWith("ABC234", 0);
    r.dispose();
  });

  // It used to keep writing behind the "Connection problem" screen: status
  // `error` left the code and slot in place, and nothing read the status.
  it.each<[string, SessionLifecycle]>([
    ["lost", { ...LIVE, kind: "lost" }],
    ["closed", { kind: "closed" }],
  ])(
    "stops writing and removes own position once the session is %s",
    async (_name, ended) => {
      const h = createHarness({ placesEnabled: false });
      const r = createRuntime(h.ports);
      r.setSources(ready());
      await h.advance(3_000);
      const writes = vi.mocked(h.ports.writePresence).mock.calls.length;

      r.setSources({ session: ended });
      await h.advance(60_000);

      expect(h.ports.writePresence).toHaveBeenCalledTimes(writes);
      expect(h.ports.removePresence).toHaveBeenCalledWith("ABC234", 0);
      expect(h.pendingBefore(SESSION_TTL_MS)).toBe(0);
      r.dispose();
    },
  );

  it("removes own position when the runtime is disposed with the page", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(ready());
    await h.advance(3_000);

    r.dispose();

    expect(h.ports.removePresence).toHaveBeenCalledWith("ABC234", 0);
  });

  it("removes nothing it never published", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources(ready({ session: { kind: "joining" } }));
    await h.advance(10_000);

    r.setSources({ session: { kind: "failed" } });
    r.dispose();

    expect(h.ports.writePresence).not.toHaveBeenCalled();
    expect(h.ports.removePresence).not.toHaveBeenCalled();
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

    r.setSources({ session: { kind: "creating" } });
    expect(r.getSnapshot().phase).toBe("creating");

    r.setSources({
      session: LIVE,
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
      session: LIVE,
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
      session: LIVE,
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
      session: LIVE,
      participants: [peer(h.now() - DEPARTED_THRESHOLD_MS)],
    });
    await h.advance(1_000);

    expect(r.getSnapshot().slots.departed[1]).toBe(true);
    // Nothing for liveness; the session's own expiry is all that is armed.
    expect(h.pendingBefore(SESSION_TTL_MS)).toBe(0);
    r.dispose();
  });

  // `lastSeen` is stamped by the server, so it is compared with server time.
  it("judges staleness against server time, not this device's clock", () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    // This device runs two minutes fast, and the peer has just written.
    const serverNowMs = h.now() - 120_000;

    r.setSources({
      session: LIVE,
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
    r.setSources({ session: LIVE, participants: [peer(h.now())] });

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
      session: LIVE,
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

    r.setSources({ session: LIVE, participants: [peer(h.now())] });
    expect(h.pending()).toBeGreaterThan(0);

    r.dispose();
    expect(h.pending()).toBe(0);
  });
});

describe("createRuntime — expiry", () => {
  /** A session one minute short of its 24 hours at the harness's epoch. */
  const ENDING: SessionLifecycle = {
    ...LIVE,
    createdAtMs: 60_000 - SESSION_TTL_MS,
  };

  // Expiry is a predicate over the server clock, woken like liveness: a
  // session with nothing ticking — no position, no peers, no heartbeat —
  // still has to notice its end.
  it("expires on its own schedule, with nothing else ticking", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources({ session: ENDING });
    expect(r.getSnapshot().phase).toBe("waiting");

    await h.advance(59_999);
    expect(r.getSnapshot().phase).toBe("waiting");

    await h.advance(1);
    expect(r.getSnapshot().phase).toBe("expired");
    expect(h.pending()).toBe(0);
    r.dispose();
  });

  // The rules refuse every write to an expired session. The presence node
  // tried again every three seconds for as long as the page stayed open,
  // behind a "Retrying…" banner.
  it("stops writing at expiry and removes own position", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources({
      session: ENDING,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 12,
      ownName: "Me",
    });
    await h.advance(60_000);
    expect(r.getSnapshot().phase).toBe("expired");
    expect(h.ports.removePresence).toHaveBeenCalledWith("ABC234", 0);
    const writes = vi.mocked(h.ports.writePresence).mock.calls.length;
    expect(writes).toBeGreaterThan(0);

    await h.advance(10 * 60_000);

    expect(h.ports.writePresence).toHaveBeenCalledTimes(writes);
    expect(h.pending()).toBe(0);
    r.dispose();
  });

  // `created` is stamped by the server. This device's clock runs 30 s
  // behind it, so the session ends 30 s early by the device's reckoning.
  it("judges expiry against server time, not this device's clock", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources({ session: ENDING, serverTimeOffsetMs: 30_000 });

    await h.advance(29_999);
    expect(r.getSnapshot().phase).toBe("waiting");

    await h.advance(1);
    expect(r.getSnapshot().phase).toBe("expired");
    r.dispose();
  });

  it("keeps saying expired once the listener is lost as well", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports);
    r.setSources({ session: ENDING });
    await h.advance(60_000);

    r.setSources({ session: { ...ENDING, kind: "lost" } });

    expect(r.getSnapshot().phase).toBe("expired");
    r.dispose();
  });
});

describe("createRuntime — the picked venue", () => {
  const M_PER_DEG_LAT = 111_320;
  function offset(p: LatLng, eastM: number, northM = 0): LatLng {
    const mPerDegLng = M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
    return {
      lat: p.lat + northM / M_PER_DEG_LAT,
      lng: p.lng + eastM / mPerDegLng,
    };
  }
  /** Equal in every respect but distance, so distance alone ranks them. */
  function place(id: string, location: LatLng): PlaceResult {
    return {
      id,
      displayName: id,
      location,
      rating: 4,
      userRatingCount: 100,
      openNow: true,
      types: ["cafe"],
    };
  }

  // Ranking is relative to the live midpoint, so a pick near the top-five cut
  // fell out of the list as people walked — with no search at all — and the
  // destination, the card's title and the camera's framing went with it, then
  // came back when they walked back.
  it("keeps a pick near the cut-off listed, and the destination, however the ranking moves", async () => {
    const midpoint = geographicCentroid([TEL_AVIV, JERUSALEM]);
    const picked = place("picked", offset(midpoint, 500));
    const places = [
      place("near1", offset(midpoint, 50)),
      place("near2", offset(midpoint, 0, 100)),
      place("near3", offset(midpoint, -150)),
      place("near4", offset(midpoint, 0, -200)),
      picked,
      place("rival", offset(midpoint, -505)),
    ];
    const h = createHarness({
      searchVenues: vi.fn().mockResolvedValue(ok(places)),
    });
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownPosition: TEL_AVIV,
      participants: [peer(1, JERUSALEM)],
    });
    await h.advance(5_000);
    r.setSources({ selectedPlace: picked });
    expect(r.getSnapshot().venues.map((v) => v.id)).toContain("picked");

    // I walk 30 m west: the midpoint moves 15 m, and "rival" now outranks the
    // pick for fifth place.
    r.setSources({ ownPosition: offset(TEL_AVIV, -30) });

    const moved = r.getSnapshot();
    expect(moved.venues.slice(0, 5).map((v) => v.id)).toContain("rival");
    expect(moved.venues.map((v) => v.id)).toContain("picked");
    expect(moved.selectedVenue?.id).toBe("picked");
    expect(moved.destination).toEqual(picked.location);

    r.setSources({ ownPosition: TEL_AVIV });
    expect(r.getSnapshot().selectedVenue?.id).toBe("picked");
    // All of it from the one search: nothing here was a new answer.
    expect(h.ports.searchVenues).toHaveBeenCalledTimes(1);
    r.dispose();
  });
});

describe("createRuntime — what the venue list says", () => {
  const SESSION = {
    session: LIVE,
    ownPosition: TEL_AVIV,
    participants: [peer(1, JERUSALEM)],
  };

  // It said "No venues found" while the first search was only scheduled.
  it("is searching, not empty, until the first answer", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, SESSION);
    expect(r.getSnapshot().venueStatus).toBe("searching");
    expect(r.getSnapshot().venues).toEqual([]);

    await h.advance(5_000);

    expect(r.getSnapshot().venueStatus).toBe("ready");
    expect(r.getSnapshot().venues.length).toBeGreaterThan(0);
    r.dispose();
  });

  // A refresh swapped the list for a skeleton until it landed.
  it("keeps the list while a newer search is out", async () => {
    const h = createHarness();
    const r = createRuntime(h.ports, SESSION);
    await h.advance(5_000);
    const listed = r
      .getSnapshot()
      .venues.map((v) => v.id)
      .sort();
    vi.mocked(h.ports.searchVenues).mockImplementation(
      () => new Promise(() => {}),
    );

    // I move 300 m: the midpoint moves 150 m, and a new search goes out.
    r.setSources({
      ownPosition: { lat: TEL_AVIV.lat + 0.0027, lng: TEL_AVIV.lng },
    });
    await h.advance(5_000);

    expect(h.ports.searchVenues).toHaveBeenCalledTimes(2);
    expect(r.getSnapshot().venueStatus).toBe("ready");
    expect(
      r
        .getSnapshot()
        .venues.map((v) => v.id)
        .sort(),
    ).toEqual(listed);
    r.dispose();
  });

  // ...and the same "No venues found" when the search had failed.
  it("says a failed search failed", async () => {
    const h = createHarness({
      searchVenues: vi
        .fn()
        .mockResolvedValue(err({ kind: "HTTP", status: 503 })),
    });
    const r = createRuntime(h.ports, SESSION);

    // Past the first search and its one retry; before the next attempt.
    await h.advance(8_000);

    expect(r.getSnapshot().venueStatus).toBe("failed");
    expect(r.getSnapshot().venues).toEqual([]);
    r.dispose();
  });

  it("is idle with venue search off", () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports, SESSION);

    expect(r.getSnapshot().venueStatus).toBe("idle");
    r.dispose();
  });
});

describe("createRuntime — departed peers and stale routes", () => {
  function session(
    participants: ParticipantSource[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 10,
      ownName: "Me",
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
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    r.setSources({ peerTrips: tripsFor(1, midpoint) });
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
    // Past the venue search's debounce, so there is a venue to pick.
    await h.advance(5_000);
    expect(r.getSnapshot().routes.filter(Boolean).length).toBeGreaterThan(0);

    r.setSources({ selectedPlace: PLACES[0] ?? null });
    expect(r.getSnapshot().destination).toEqual(PLACES[0]?.location);
    expect(r.getSnapshot().routes.filter(Boolean)).toHaveLength(0);

    await h.advance(10_000);
    expect(r.getSnapshot().routes.filter(Boolean).length).toBeGreaterThan(0);
    r.dispose();
  });
});

describe("createRuntime — the meeting point", () => {
  /** Live in slot 0, sharing from Tel Aviv, with a peer in Jerusalem. */
  function meeting(h: ReturnType<typeof createHarness>) {
    const r = createRuntime(h.ports);
    r.setSources({
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 10,
      participants: [peer(1, JERUSALEM)],
    });
    return r;
  }

  const HAIFA: LatLng = { lat: 32.794, lng: 34.99 };

  it("goes to the live midpoint until somebody sets a meeting point", () => {
    const h = createHarness();
    const r = meeting(h);

    expect(r.getSnapshot().pin).toBeNull();
    expect(r.getSnapshot().destination).toEqual(r.getSnapshot().midpoint);
    r.dispose();
  });

  it("fixes the destination where it is set, as this device's slot", () => {
    const h = createHarness();
    const r = meeting(h);
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");

    r.setMeetingPoint(midpoint, null);

    const pin = r.getSnapshot().pin;
    expect(pin).toMatchObject({
      by: 0,
      byName: null,
      position: midpoint,
      name: null,
    });
    expect(r.getSnapshot().destination).toEqual(midpoint);
    r.dispose();
  });

  // The defect: the Navigate target was the live centroid, and moved a
  // kilometre for every two the others drove.
  it("keeps the destination where it was set as people move", () => {
    const h = createHarness();
    const r = meeting(h);
    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    r.setMeetingPoint(midpoint, null);

    r.setSources({ participants: [peer(1, HAIFA)] });

    expect(r.getSnapshot().midpoint).not.toEqual(midpoint);
    expect(r.getSnapshot().destination).toEqual(midpoint);
    r.dispose();
  });

  // The defect: the others' Navigate buttons went with the midpoint the
  // moment the person who had tapped Navigate left the page.
  it("keeps the meeting point once everybody else has gone", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });

    r.setSources({ participants: [], peerPins: [] });

    expect(r.getSnapshot().midpoint).toBeNull();
    expect(r.getSnapshot().destination).toEqual(HAIFA);
    expect(r.getSnapshot().pin).toMatchObject({
      by: 1,
      byName: null,
      position: HAIFA,
    });
    r.dispose();
  });

  it("adopts a peer's pin, and routes everyone to it", async () => {
    const h = createHarness();
    const r = meeting(h);

    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: "Cafe" },
      ],
    });
    await h.advance(10_000);

    expect(r.getSnapshot().destination).toEqual(HAIFA);
    const calls = vi.mocked(h.ports.fetchRoute).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1][1]).toEqual(HAIFA);
    r.dispose();
  });

  // Two people tap Navigate in the same second, and the other's pin reaches
  // the server first: the rules refuse this device's copy, and it takes
  // theirs rather than keeping its own.
  it("takes the copy the database holds over its own proposal", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setMeetingPoint(JERUSALEM, null);
    expect(r.getSnapshot().destination).toEqual(JERUSALEM);

    r.setSources({
      peerPins: [
        { at: 9_000, by: 1, byName: "Dana", position: HAIFA, name: null },
      ],
    });

    expect(r.getSnapshot().pin).toMatchObject({ by: 1, position: HAIFA });
    expect(r.getSnapshot().destination).toEqual(HAIFA);
    r.dispose();
  });

  // Nobody moves it: not a second Navigate, not a later pin from anyone.
  it("never moves the meeting point once there is one", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });
    const before = r.getSnapshot().pin;

    r.setMeetingPoint(JERUSALEM, "Elsewhere");
    r.setSources({ peerPins: [] });

    expect(r.getSnapshot().pin).toBe(before);
    expect(r.getSnapshot().destination).toEqual(HAIFA);
    r.dispose();
  });

  // Written as the others will read it back: their copies must be this one
  // exactly, or the rules refuse them.
  it("signs a pin with this device's name as the others will read it", () => {
    const named = meeting(createHarness());
    named.setSources({ ownName: "  Dana  " });
    named.setMeetingPoint(HAIFA, `  ${"x".repeat(100)} `);
    expect(named.getSnapshot().pin).toMatchObject({
      byName: "Dana",
      name: "x".repeat(80),
    });
    named.dispose();

    const unnamed = meeting(createHarness());
    unnamed.setSources({ ownName: "  " });
    unnamed.setMeetingPoint(HAIFA, "   ");
    expect(unnamed.getSnapshot().pin).toMatchObject({
      byName: null,
      name: null,
    });
    unnamed.dispose();
  });

  // A proposal is for the session it was made in.
  it("does not carry a proposal into another session", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setMeetingPoint(HAIFA, null);
    expect(r.getSnapshot().pin).not.toBeNull();

    r.setSources({ session: { ...LIVE, code: "XYZ789" } });

    expect(r.getSnapshot().pin).toBeNull();
    r.dispose();
  });

  it("stamps a pin with the server's clock", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({ serverTimeOffsetMs: 7_000 });

    r.setMeetingPoint(HAIFA, null);

    expect(r.getSnapshot().pin?.at).toBe(7_000);
    r.dispose();
  });

  it("sets nothing while there is no session slot to set it as", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);

    r.setMeetingPoint(HAIFA, null);

    expect(r.getSnapshot().pin).toBeNull();
    r.dispose();
  });

  // Whoever arrives or comes back after the setter has gone learns the pin
  // from the copies the others publish.
  it("publishes its copy of the pin at once, under its own slot", async () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: "Cafe" },
      ],
    });

    await h.advance(0);

    expect(h.ports.writeMeet).toHaveBeenCalledWith(
      "ABC234",
      0,
      {
        at: 1_000,
        by: 1,
        byName: null,
        lat: HAIFA.lat,
        lng: HAIFA.lng,
        name: "Cafe",
      },
      expect.anything(),
    );
    r.dispose();
  });

  it("publishes nothing while nobody has set a meeting point", async () => {
    const h = createHarness();
    const r = meeting(h);

    await h.advance(60_000);

    expect(h.ports.writeMeet).not.toHaveBeenCalled();
    r.dispose();
  });

  // Taken down with own position: whoever stops sharing stops sharing all of
  // it, and it is deleted the same way.
  it("removes its copy when location is turned off", async () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });
    await h.advance(0);

    r.setSources({ ownPosition: null });

    expect(h.ports.removeMeet).toHaveBeenCalledWith("ABC234", 0);
    // The pin itself stays: it is where the others are going.
    expect(r.getSnapshot().pin).toMatchObject({ position: HAIFA });
    r.dispose();
  });

  it("removes its copy when the page closes", async () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });
    await h.advance(0);

    r.setSources({ session: { kind: "closed" } });

    expect(h.ports.removeMeet).toHaveBeenCalledWith("ABC234", 0);
    r.dispose();
  });

  it("removes its copy when the runtime is disposed", async () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });
    await h.advance(0);

    r.dispose();

    expect(h.ports.removeMeet).toHaveBeenCalledWith("ABC234", 0);
  });

  it("removes nothing it never published", () => {
    const h = createHarness();
    const r = meeting(h);

    r.setSources({ session: { kind: "closed" } });
    r.dispose();

    expect(h.ports.removeMeet).not.toHaveBeenCalled();
  });

  it("keeps its reference while the same pin arrives again", () => {
    const h = createHarness();
    const r = meeting(h);
    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: HAIFA, name: null },
      ],
    });
    const before = r.getSnapshot();

    r.setSources({
      peerPins: [
        { at: 1_000, by: 1, byName: null, position: { ...HAIFA }, name: null },
        { at: 1_000, by: 1, byName: null, position: { ...HAIFA }, name: null },
      ],
    });

    expect(r.getSnapshot()).toBe(before);
    r.dispose();
  });
});

describe("createRuntime — who has been seen sharing", () => {
  it("remembers a slot after its participant has gone", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);
    r.setSources({
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      participants: [peer(2, JERUSALEM)],
    });
    expect(r.getSnapshot().seenSharing[2]).toBe(true);

    r.setSources({ participants: [] });

    expect(r.getSnapshot().seenSharing[2]).toBe(true);
    expect(r.getSnapshot().seenSharing.filter(Boolean)).toHaveLength(1);
    r.dispose();
  });

  it("never counts this device's own slot", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);
    r.setSources({ session: LIVE, ownUid: "own-uid", ownPosition: TEL_AVIV });

    expect(r.getSnapshot().seenSharing.some(Boolean)).toBe(false);
    r.dispose();
  });

  it("keeps its reference while nobody new appears", () => {
    const h = createHarness();
    const r = createRuntime(h.ports);
    r.setSources({
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      participants: [peer(2, JERUSALEM)],
    });
    const before = r.getSnapshot().seenSharing;

    r.setSources({ participants: [peer(2, { lat: 31.78, lng: 35.22 })] });

    expect(r.getSnapshot().seenSharing).toBe(before);
    r.dispose();
  });
});

describe("createRuntime — own trip", () => {
  function trip(h: ReturnType<typeof createHarness>) {
    return createRuntime(h.ports, {
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 10,
      participants: [peer(1, JERUSALEM)],
    });
  }

  // The others draw this device's way from what it publishes: nobody routes
  // anybody else any more.
  it("publishes its own route for the others, under its own slot", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = trip(h);
    expect(h.ports.writeTrip).not.toHaveBeenCalled();

    await h.advance(10_000);

    const midpoint = r.getSnapshot().midpoint;
    if (midpoint === null) throw new Error("no midpoint");
    expect(h.ports.writeTrip).toHaveBeenCalledWith(
      "ABC234",
      0,
      expect.objectContaining({
        lat: midpoint.lat,
        lng: midpoint.lng,
        profile: "driving",
        duration: 100,
        distance: 1000,
      }),
      expect.anything(),
    );
    r.dispose();
  });

  it("publishes nothing while it has no route", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports, {
      session: LIVE,
      ownUid: "own-uid",
      ownPosition: TEL_AVIV,
      ownAccuracy: 10,
    });

    await h.advance(60_000);

    expect(h.ports.writeTrip).not.toHaveBeenCalled();
    r.dispose();
  });

  // Whoever stops sharing stops sharing all of it.
  it("removes its trip with its position", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = trip(h);
    await h.advance(10_000);

    r.setSources({ ownPosition: null });

    expect(h.ports.removeTrip).toHaveBeenCalledWith("ABC234", 0);
    r.dispose();
  });

  it("removes its trip when the runtime is disposed", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = trip(h);
    await h.advance(10_000);

    r.dispose();

    expect(h.ports.removeTrip).toHaveBeenCalledWith("ABC234", 0);
  });
});

describe("createRuntime — sharing", () => {
  const SHARING = {
    session: LIVE,
    ownUid: "own-uid",
    ownPosition: TEL_AVIV,
    ownAccuracy: 10,
  };

  /** Presence writes that land only when the test says so. */
  function heldWrites(h: ReturnType<typeof createHarness>) {
    const held: { land?: () => void } = {};
    vi.mocked(h.ports.writePresence).mockImplementation(
      () =>
        new Promise((resolve) => {
          held.land = () => resolve(ok(undefined));
        }),
    );
    return held;
  }

  // The others are read only while this is true, and a read the rules may
  // one day gate on own position must not beat the write that publishes it.
  it("is not sharing until the server has taken own position", async () => {
    const h = createHarness({ placesEnabled: false });
    const held = heldWrites(h);
    const r = createRuntime(h.ports, SHARING);
    expect(r.getSnapshot().sharing).toBe(false);

    await h.advance(5_000);
    expect(h.ports.writePresence).toHaveBeenCalled();
    expect(r.getSnapshot().sharing).toBe(false);

    held.land?.();
    await h.flush();
    expect(r.getSnapshot().sharing).toBe(true);
    r.dispose();
  });

  it("is not sharing while the server refuses own position", async () => {
    const h = createHarness({
      placesEnabled: false,
      writePresence: vi
        .fn()
        .mockResolvedValue(err({ kind: "DENIED", detail: "denied" })),
    });
    const r = createRuntime(h.ports, SHARING);

    await h.advance(30_000);

    expect(r.getSnapshot().sharing).toBe(false);
    r.dispose();
  });

  // Turning location off is turning sharing off, and with it the others.
  // Turned on again, the answer to the earlier write does not count.
  it("stops when location is turned off, and waits for the next write to start again", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports, SHARING);
    await h.advance(5_000);
    expect(r.getSnapshot().sharing).toBe(true);

    r.setSources({ ownPosition: null });
    expect(r.getSnapshot().sharing).toBe(false);

    const held = heldWrites(h);
    r.setSources({ ownPosition: TEL_AVIV });
    expect(r.getSnapshot().sharing).toBe(false);
    await h.advance(12_000);
    expect(r.getSnapshot().sharing).toBe(false);

    held.land?.();
    await h.flush();
    expect(r.getSnapshot().sharing).toBe(true);
    r.dispose();
  });

  it("stops when the session closes", async () => {
    const h = createHarness({ placesEnabled: false });
    const r = createRuntime(h.ports, SHARING);
    await h.advance(5_000);

    r.setSources({ session: { kind: "closed" } });

    expect(r.getSnapshot().sharing).toBe(false);
    r.dispose();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPresenceWriter } from "./presence-rtdb";
import type { PresenceValue } from "./presence-rtdb";
import type { ParticipantIndex } from "./participant-config";
import type { Database } from "firebase/database";

const mockSet = vi.fn();
const mockRemove = vi.fn();
const mockOnDisconnectRemove = vi.fn();
const mockOnValue = vi.fn();

/** Plays `.info/connected` to the writer's latest subscription. */
let emitConnected: (connected: boolean) => void = () => {};

vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path?: string) => ({ path }),
  set: (r: unknown, v: unknown) => mockSet(r, v),
  remove: (r: unknown) => mockRemove(r),
  onDisconnect: (r: unknown) => ({ remove: () => mockOnDisconnectRemove(r) }),
  onValue: (r: unknown, cb: (snapshot: { val: () => unknown }) => void) => {
    mockOnValue(r);
    emitConnected = (connected) => cb({ val: () => connected });
    return () => {};
  },
  serverTimestamp: () => SERVER_TIMESTAMP,
}));

/** Stands in for `serverTimestamp()`'s placeholder, which the server resolves. */
const SERVER_TIMESTAMP = { ".sv": "timestamp" };

const db = { _db: true } as unknown as Database;
const live = () => new AbortController().signal;

const UID = "uid-1";
const SLOT: ParticipantIndex = 1;

const VALUE: PresenceValue = {
  uid: UID,
  lat: 32.08,
  lng: 34.78,
  accuracy: 10,
  name: "Me",
};

/** Keyed by slot, not uid — the slot is the server-arbitrated claim. */
const PATH = "sessions/ABC234/participants/1";

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockOnDisconnectRemove.mockResolvedValue(undefined);
});

describe("createPresenceWriter", () => {
  it("writes the value at the slot-scoped path", async () => {
    const writer = createPresenceWriter(db);

    const result = await writer.write("ABC234", SLOT, VALUE, live());

    expect(result).toEqual({ ok: true, value: undefined });
    expect(mockSet).toHaveBeenCalledWith(
      { path: PATH },
      { ...VALUE, ts: SERVER_TIMESTAMP },
    );
  });

  // Peers judge staleness from `ts`, and device clocks disagree by minutes on
  // some phones. A device-stamped `ts` made a participant with a slow clock
  // look stale to everyone, and one with a fast clock look live after leaving.
  it("stamps each write with the server's clock, not the device's", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockSet.mock.calls[0]?.[1]).toMatchObject({ ts: SERVER_TIMESTAMP });
  });

  // Regression guard: a participant whose socket drops without a clean
  // teardown must be removed server-side, or their stale position keeps
  // dragging the computed midpoint for everyone else.
  it("arms a server-side onDisconnect removal on the first write", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledWith({ path: PATH });
  });

  it("arms it once, not on every write", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());
    await writer.write("ABC234", SLOT, VALUE, live());
    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(3);
  });

  it("carries the uid in the payload for the rules to validate", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockSet).toHaveBeenCalledWith(
      { path: PATH },
      expect.objectContaining({ uid: UID }),
    );
  });

  it("keys separate slots separately", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", 0, { ...VALUE, uid: "creator" }, live());
    await writer.write("ABC234", 4, { ...VALUE, uid: "latecomer" }, live());

    expect(mockSet).toHaveBeenCalledWith(
      { path: "sessions/ABC234/participants/0" },
      expect.objectContaining({ uid: "creator" }),
    );
    expect(mockSet).toHaveBeenCalledWith(
      { path: "sessions/ABC234/participants/4" },
      expect.objectContaining({ uid: "latecomer" }),
    );
  });

  it("re-arms for a different session", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());
    await writer.write("ZZZ999", SLOT, VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });

  it("re-arms on the next write if arming failed", async () => {
    mockOnDisconnectRemove.mockRejectedValueOnce(new Error("offline"));
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());
    await Promise.resolve();
    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });

  it("returns a typed failure rather than throwing when the write fails", async () => {
    mockSet.mockRejectedValueOnce(new Error("Disconnected"));
    const writer = createPresenceWriter(db);

    const result = await writer.write("ABC234", SLOT, VALUE, live());

    expect(result).toEqual({
      ok: false,
      error: { kind: "NETWORK", detail: "Disconnected" },
    });
  });

  // Classified as a network failure, a denial was retried three times per
  // write and counted towards opening the breaker on a healthy database.
  it("reports a rules denial as DENIED, not as a network failure", async () => {
    // Worded as @firebase/database's errorForServerCode words it.
    const denial =
      "permission_denied at /sessions/ABC234/participants/1: " +
      "Client doesn't have permission to access the desired data.";
    mockSet.mockRejectedValueOnce(new Error(denial));
    const writer = createPresenceWriter(db);

    const result = await writer.write("ABC234", SLOT, VALUE, live());

    expect(result).toEqual({
      ok: false,
      error: { kind: "DENIED", detail: denial },
    });
  });

  it("propagates an abort so the resource discards a superseded write", async () => {
    const controller = new AbortController();
    mockSet.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });
    const writer = createPresenceWriter(db);

    await expect(
      writer.write("ABC234", SLOT, VALUE, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes presence at the slot-scoped path", () => {
    const writer = createPresenceWriter(db);

    writer.remove("ABC234", SLOT);

    expect(mockRemove).toHaveBeenCalledWith({ path: PATH });
  });

  it("re-arms onDisconnect after a removal", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());
    writer.remove("ABC234", SLOT);
    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });

  // Regression guard: the server runs an onDisconnect once and forgets it.
  // Armed only per session, it covered the first dropped connection; after a
  // reconnect, the next drop left the participant's last position stored
  // indefinitely — what the privacy policy says does not happen.
  it("re-arms every published path when the connection comes back", async () => {
    const writer = createPresenceWriter(db);
    await writer.write("ABC234", SLOT, VALUE, live());
    emitConnected(true); // the connection the write armed

    emitConnected(false);
    emitConnected(true);

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
    expect(mockOnDisconnectRemove).toHaveBeenLastCalledWith({ path: PATH });
  });

  it("does not re-arm for the connection it subscribed on", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", SLOT, VALUE, live());
    emitConnected(true);

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm a removed path on reconnect", async () => {
    const writer = createPresenceWriter(db);
    await writer.write("ABC234", SLOT, VALUE, live());
    emitConnected(true);
    writer.remove("ABC234", SLOT);

    emitConnected(false);
    emitConnected(true);

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(1);
  });

  // The writer is built at the composition root. Listening there would open
  // the RTDB socket before App Check has a token, leaving it unattested.
  it("does not touch the connection until the first write", async () => {
    const writer = createPresenceWriter(db);
    expect(mockOnValue).not.toHaveBeenCalled();

    await writer.write("ABC234", SLOT, VALUE, live());
    await writer.write("ABC234", SLOT, VALUE, live());

    expect(mockOnValue).toHaveBeenCalledTimes(1);
    expect(mockOnValue).toHaveBeenCalledWith({ path: ".info/connected" });
  });
});

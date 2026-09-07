import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPresenceWriter } from "./presence-rtdb";
import type { PresenceValue } from "./presence-rtdb";
import type { Database } from "firebase/database";

const mockSet = vi.fn();
const mockRemove = vi.fn();
const mockOnDisconnectRemove = vi.fn();

vi.mock("firebase/database", () => ({
  ref: (_db: unknown, path?: string) => ({ path }),
  set: (r: unknown, v: unknown) => mockSet(r, v),
  remove: (r: unknown) => mockRemove(r),
  onDisconnect: (r: unknown) => ({ remove: () => mockOnDisconnectRemove(r) }),
}));

const db = { _db: true } as unknown as Database;
const live = () => new AbortController().signal;

const VALUE: PresenceValue = {
  lat: 32.08,
  lng: 34.78,
  accuracy: 10,
  ts: 1_700_000_000_000,
  name: "Me",
};

const PATH = "sessions/ABC234/participants/uid-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockOnDisconnectRemove.mockResolvedValue(undefined);
});

describe("createPresenceWriter", () => {
  it("writes the value at the uid-scoped path", async () => {
    const writer = createPresenceWriter(db);

    const result = await writer.write("ABC234", "uid-1", VALUE, live());

    expect(result).toEqual({ ok: true, value: undefined });
    expect(mockSet).toHaveBeenCalledWith({ path: PATH }, VALUE);
  });

  // Regression guard: a participant whose socket drops without a clean
  // teardown must be removed server-side, or their stale position keeps
  // dragging the computed midpoint for everyone else.
  it("arms a server-side onDisconnect removal on the first write", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", "uid-1", VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledWith({ path: PATH });
  });

  it("arms it once, not on every write", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", "uid-1", VALUE, live());
    await writer.write("ABC234", "uid-1", VALUE, live());
    await writer.write("ABC234", "uid-1", VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(3);
  });

  it("re-arms for a different session", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", "uid-1", VALUE, live());
    await writer.write("ZZZ999", "uid-1", VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });

  it("re-arms on the next write if arming failed", async () => {
    mockOnDisconnectRemove.mockRejectedValueOnce(new Error("offline"));
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", "uid-1", VALUE, live());
    await Promise.resolve();
    await writer.write("ABC234", "uid-1", VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });

  it("returns a typed failure rather than throwing when the write fails", async () => {
    mockSet.mockRejectedValueOnce(new Error("permission_denied"));
    const writer = createPresenceWriter(db);

    const result = await writer.write("ABC234", "uid-1", VALUE, live());

    expect(result).toEqual({
      ok: false,
      error: { kind: "NETWORK", detail: "permission_denied" },
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
      writer.write("ABC234", "uid-1", VALUE, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("removes presence at the uid-scoped path", () => {
    const writer = createPresenceWriter(db);

    writer.remove("ABC234", "uid-1");

    expect(mockRemove).toHaveBeenCalledWith({ path: PATH });
  });

  it("re-arms onDisconnect after a removal", async () => {
    const writer = createPresenceWriter(db);

    await writer.write("ABC234", "uid-1", VALUE, live());
    writer.remove("ABC234", "uid-1");
    await writer.write("ABC234", "uid-1", VALUE, live());

    expect(mockOnDisconnectRemove).toHaveBeenCalledTimes(2);
  });
});

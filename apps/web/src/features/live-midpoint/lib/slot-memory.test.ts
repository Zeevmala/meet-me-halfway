import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { recallSlot, rememberSlot } from "./slot-memory";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("slot-memory", () => {
  it("returns null for a session it has never seen", () => {
    expect(recallSlot("ABC234")).toBeNull();
  });

  it("round-trips a slot", () => {
    rememberSlot("ABC234", 3);
    expect(recallSlot("ABC234")).toBe(3);
  });

  it("keys by session code", () => {
    rememberSlot("ABC234", 3);
    expect(recallSlot("ZZZ999")).toBeNull();
  });

  it("remembers slot 0", () => {
    rememberSlot("ABC234", 0);
    expect(recallSlot("ABC234")).toBe(0);
  });

  // The value is read back into a `ParticipantIndex`, and everything keyed by
  // slot — colours, Mapbox layer ids, the RTDB participant key — assumes 0..4.
  it("rejects a stored value outside 0..4", () => {
    for (const bad of ["5", "-1", "1.5", "", "nope"]) {
      localStorage.setItem("mmhw:slot:ABC234", bad);
      expect(recallSlot("ABC234")).toBeNull();
    }
  });

  it("survives storage being unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(() => rememberSlot("ABC234", 2)).not.toThrow();
    expect(recallSlot("ABC234")).toBeNull();
  });
});

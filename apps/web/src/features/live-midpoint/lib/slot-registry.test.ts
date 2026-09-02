import { describe, it, expect } from "vitest";
import { createSlotRegistry } from "./slot-registry";
import { MAX_PARTICIPANTS } from "./participant-config";

const CREATOR = "uid-creator";

describe("createSlotRegistry", () => {
  it("gives the creator slot 0", () => {
    const reg = createSlotRegistry(CREATOR);
    expect(reg.assign(CREATOR)).toBe(0);
  });

  it("reserves slot 0 for the creator even when they arrive last", () => {
    const reg = createSlotRegistry(CREATOR);
    reg.assign("uid-a");
    reg.assign("uid-b");
    expect(reg.assign(CREATOR)).toBe(0);
  });

  it("allocates joiners the lowest free slot starting at 1", () => {
    const reg = createSlotRegistry(CREATOR);
    expect(reg.assign("uid-a")).toBe(1);
    expect(reg.assign("uid-b")).toBe(2);
    expect(reg.assign("uid-c")).toBe(3);
  });

  it("is idempotent — re-assigning a known uid returns the same slot", () => {
    const reg = createSlotRegistry(CREATOR);
    const first = reg.assign("uid-a");
    expect(reg.assign("uid-a")).toBe(first);
    expect(reg.assign("uid-a")).toBe(first);
    expect(reg.size()).toBe(1);
  });

  // Regression: the old dense-rank scheme renumbered every later uid when
  // somebody left, silently moving colours and route attribution.
  it("does not renumber survivors when a participant departs", () => {
    const reg = createSlotRegistry(CREATOR);
    reg.assignAll([CREATOR, "uid-a", "uid-b", "uid-c"]);
    const before = reg.slotOf("uid-c");

    // "uid-a" leaves: the next snapshot simply omits them.
    reg.assignAll([CREATOR, "uid-b", "uid-c"]);

    expect(reg.slotOf("uid-c")).toBe(before);
    expect(reg.slotOf("uid-b")).toBe(2);
    expect(reg.slotOf(CREATOR)).toBe(0);
  });

  // Regression: own index was ranked over `participantUids` while others were
  // ranked over `participants`, so the two could collide.
  it("never issues one slot to two uids across differing key sets", () => {
    const reg = createSlotRegistry(CREATOR);

    // Registration set — everyone who has registered.
    reg.assignAll([CREATOR, "uid-a", "uid-b"]);
    // Position set — only those who have actually reported a fix.
    reg.assignAll([CREATOR, "uid-b"]);

    const issued = [CREATOR, "uid-a", "uid-b"].map((u) => reg.slotOf(u));
    expect(new Set(issued).size).toBe(issued.length);
  });

  // Regression: Math.min(idx, MAX_PARTICIPANTS - 1) aliased surplus uids onto
  // the last slot instead of rejecting them.
  it("rejects surplus participants instead of aliasing them", () => {
    const reg = createSlotRegistry(CREATOR);
    reg.assign(CREATOR);
    for (let i = 1; i < MAX_PARTICIPANTS; i++) {
      expect(reg.assign(`uid-${i}`)).toBe(i);
    }
    expect(reg.assign("uid-surplus")).toBe(null);
    expect(reg.slotOf("uid-surplus")).toBe(null);
    expect(reg.size()).toBe(MAX_PARTICIPANTS);
  });

  it("allocates independently of snapshot key order", () => {
    const a = createSlotRegistry(CREATOR);
    const b = createSlotRegistry(CREATOR);
    a.assignAll(["uid-c", "uid-a", "uid-b"]);
    b.assignAll(["uid-b", "uid-c", "uid-a"]);

    for (const uid of ["uid-a", "uid-b", "uid-c"]) {
      expect(a.slotOf(uid)).toBe(b.slotOf(uid));
    }
  });

  it("keeps slot 0 free when the creator is not yet known", () => {
    const reg = createSlotRegistry("");
    expect(reg.assign("uid-a")).toBe(1);
    expect(reg.slotOf("uid-a")).toBe(1);
  });

  it("reports null for a uid it has never seen", () => {
    const reg = createSlotRegistry(CREATOR);
    expect(reg.slotOf("nobody")).toBe(null);
  });
});

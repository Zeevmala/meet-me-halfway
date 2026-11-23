import { describe, it, expect } from "vitest";
import { meetingPath, parseMeeting } from "./meeting-rtdb";

describe("parseMeeting", () => {
  it("reads a published point", () => {
    expect(
      parseMeeting({
        lat: 31.9,
        lng: 35,
        mask: "11000",
        ts: 1_700_000_000_000,
      }),
    ).toEqual({ point: { lat: 31.9, lng: 35 }, mask: "11000" });
  });

  it("reads nothing from an empty node", () => {
    expect(parseMeeting(null)).toBeNull();
  });

  // A snapshot is untrusted input to this process, whatever the rules say.
  it.each([
    ["a string", "31.9,35"],
    ["a missing mask", { lat: 31.9, lng: 35 }],
    ["a textual coordinate", { lat: "31.9", lng: 35, mask: "11000" }],
    ["a non-finite coordinate", { lat: Number.NaN, lng: 35, mask: "11000" }],
  ])("reads nothing from %s", (_name, value) => {
    expect(parseMeeting(value)).toBeNull();
  });
});

describe("meetingPath", () => {
  it("is the session's meeting node", () => {
    expect(meetingPath("ABC234")).toBe("sessions/ABC234/meeting");
  });
});

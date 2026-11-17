import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasConsent, rememberConsent } from "./consent";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consent", () => {
  it("has none until it is given", () => {
    expect(hasConsent(null)).toBe(false);
    expect(hasConsent("K7M2QX")).toBe(false);
  });

  it("remembers agreeing to start a session, across a reload of the tab", () => {
    rememberConsent(null);

    expect(hasConsent(null)).toBe(true);
  });

  it("remembers agreeing to join a session by its code", () => {
    rememberConsent("K7M2QX");

    expect(hasConsent("K7M2QX")).toBe(true);
  });

  // Agreeing to share with one group is not agreeing to share with the next.
  it("does not carry over to a different session", () => {
    rememberConsent("K7M2QX");

    expect(hasConsent("P3RT9W")).toBe(false);
    expect(hasConsent(null)).toBe(false);
  });

  // The creator agrees to "a session of my own"; once it exists the reload
  // lands on its code, and that is the same agreement.
  it("moves from starting a session to the session that was started", () => {
    rememberConsent(null);
    rememberConsent("K7M2QX");

    expect(hasConsent("K7M2QX")).toBe(true);
    expect(hasConsent(null)).toBe(false);
  });

  it("asks again rather than throw when session storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => rememberConsent(null)).not.toThrow();
    expect(hasConsent(null)).toBe(false);
  });
});

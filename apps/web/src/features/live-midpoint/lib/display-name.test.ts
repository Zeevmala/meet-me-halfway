import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getOrCreateDisplayName, sanitizeName } from "./display-name";

const STORAGE_KEY = "mmhw:displayName";

describe("sanitizeName", () => {
  it("returns null for non-string inputs", () => {
    expect(sanitizeName(undefined)).toBeNull();
    expect(sanitizeName(null)).toBeNull();
    expect(sanitizeName(42)).toBeNull();
    expect(sanitizeName({})).toBeNull();
  });

  it("returns null for empty/whitespace strings", () => {
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
  });

  it("trims whitespace and caps length at 20", () => {
    expect(sanitizeName("  Alex  ")).toBe("Alex");
    expect(sanitizeName("a".repeat(40))).toBe("a".repeat(20));
  });
});

describe("getOrCreateDisplayName", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("returns a stored value when one exists", () => {
    localStorage.setItem(STORAGE_KEY, "Alex");
    expect(getOrCreateDisplayName()).toBe("Alex");
  });

  it("caps a stored value at 20 chars", () => {
    localStorage.setItem(STORAGE_KEY, "a".repeat(40));
    expect(getOrCreateDisplayName()).toBe("a".repeat(20));
  });

  it("derives 'iPhone' on iOS UA and persists it", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    expect(getOrCreateDisplayName()).toBe("iPhone");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("iPhone");
  });

  it("derives 'Android' on Android UA", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    });
    expect(getOrCreateDisplayName()).toBe("Android");
  });

  it("derives 'Mac' on macOS UA", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    });
    expect(getOrCreateDisplayName()).toBe("Mac");
  });

  it("derives 'Windows' on Windows UA", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    expect(getOrCreateDisplayName()).toBe("Windows");
  });

  it("falls back to 'Guest' on unknown UA", () => {
    vi.stubGlobal("navigator", { userAgent: "SomethingWeird/1.0" });
    expect(getOrCreateDisplayName()).toBe("Guest");
  });

  it("prefers stored value over UA derivation", () => {
    localStorage.setItem(STORAGE_KEY, "Custom");
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    expect(getOrCreateDisplayName()).toBe("Custom");
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getOrCreateDisplayName,
  sanitizeName,
  saveDisplayName,
  firstLetter,
  isDerivedName,
} from "./display-name";

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

describe("saveDisplayName", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("persists a trimmed value and returns it", () => {
    const result = saveDisplayName("  Zeev  ");
    expect(result).toBe("Zeev");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Zeev");
  });

  it("caps a long value at 20 chars before storing", () => {
    const result = saveDisplayName("a".repeat(40));
    expect(result).toBe("a".repeat(20));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("a".repeat(20));
  });

  it("falls back to UA-derived name when input is empty", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    });
    const result = saveDisplayName("   ");
    expect(result).toBe("Android");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("Android");
  });

  it("falls back to UA-derived name when input is non-string-like", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    });
    // sanitizeName rejects non-strings; saveDisplayName should fall back.
    const result = saveDisplayName(42 as unknown as string);
    expect(result).toBe("Mac");
  });
});

describe("firstLetter", () => {
  it("returns null for null/undefined/empty", () => {
    expect(firstLetter(null)).toBeNull();
    expect(firstLetter(undefined)).toBeNull();
    expect(firstLetter("")).toBeNull();
    expect(firstLetter("   ")).toBeNull();
  });

  it("returns uppercase first character for ASCII names", () => {
    expect(firstLetter("Zeev")).toBe("Z");
    expect(firstLetter("alex")).toBe("A");
    expect(firstLetter("  iPhone ")).toBe("I");
  });

  it("uppercases unicode letters", () => {
    expect(firstLetter("דני")).toBe("ד"); // Hebrew has no upper/lower case
    expect(firstLetter("éric")).toBe("É");
  });

  it("handles surrogate pairs (emoji) without splitting", () => {
    // Spread the codepoint with Array.from so the test mirrors the impl.
    const flag = "🇮🇱Zeev";
    const result = firstLetter(flag);
    // The emoji's first codepoint is captured as one unit; toUpperCase is a no-op on it.
    expect(result).toBe(Array.from(flag)[0]!.toUpperCase());
  });
});

describe("isDerivedName", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false for null/undefined/empty values", () => {
    expect(isDerivedName(null)).toBe(false);
    expect(isDerivedName(undefined)).toBe(false);
    expect(isDerivedName("")).toBe(false);
  });

  it("returns true when the name matches the UA-derived label", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    expect(isDerivedName("Windows")).toBe(true);
    expect(isDerivedName("  Windows  ")).toBe(true);
  });

  it("returns false for a user-chosen name", () => {
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    });
    expect(isDerivedName("Zeev")).toBe(false);
  });
});

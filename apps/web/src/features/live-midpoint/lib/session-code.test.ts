import { describe, it, expect } from "vitest";
import { generateCode, isValidCode, normalizeCode } from "./session-code";

// The exact alphabet used in session-code.ts
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

describe("generateCode", () => {
  it("produces a string of exactly 6 characters", () => {
    const code = generateCode();
    expect(code).toHaveLength(CODE_LENGTH);
  });

  it("uses only characters from the allowed alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect(ALPHABET).toContain(ch);
      }
    }
  });

  it("never includes ambiguous characters (0, O, 1, I, L)", () => {
    const ambiguous = new Set(["0", "O", "1", "I", "L"]);
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect(ambiguous.has(ch)).toBe(false);
      }
    }
  });

  it("produces unique codes over 1000 runs", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateCode());
    }
    // With 29^6 ≈ 594M possibilities, 1000 codes should all be unique
    expect(codes.size).toBe(1000);
  });

  it("always returns uppercase", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      expect(code).toBe(code.toUpperCase());
    }
  });
});

describe("isValidCode", () => {
  it("accepts valid 6-char codes from the alphabet", () => {
    expect(isValidCode("ABC234")).toBe(true);
    expect(isValidCode("XXXXXX")).toBe(true);
    expect(isValidCode("234567")).toBe(true);
    expect(isValidCode("ZZZZZ9")).toBe(true);
  });

  it("accepts generated codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidCode(generateCode())).toBe(true);
    }
  });

  it("rejects empty string", () => {
    expect(isValidCode("")).toBe(false);
  });

  it("rejects codes that are too short", () => {
    expect(isValidCode("ABC23")).toBe(false);
    expect(isValidCode("A")).toBe(false);
  });

  it("rejects codes that are too long", () => {
    expect(isValidCode("ABC2345")).toBe(false);
    expect(isValidCode("ABCDEFGH")).toBe(false);
  });

  it("rejects ambiguous character 0 (zero)", () => {
    expect(isValidCode("A0BCDE")).toBe(false);
  });

  it("rejects ambiguous character O", () => {
    expect(isValidCode("AOBCDE")).toBe(false);
  });

  it("rejects ambiguous character 1 (one)", () => {
    expect(isValidCode("A1BCDE")).toBe(false);
  });

  it("rejects ambiguous character I", () => {
    expect(isValidCode("AIBCDE")).toBe(false);
  });

  it("rejects ambiguous character L", () => {
    expect(isValidCode("ALBCDE")).toBe(false);
  });

  it("rejects lowercase (case-sensitive)", () => {
    expect(isValidCode("abcdef")).toBe(false);
    expect(isValidCode("abc234")).toBe(false);
  });

  it("rejects strings with spaces", () => {
    expect(isValidCode(" ABC23")).toBe(false);
    expect(isValidCode("ABC 23")).toBe(false);
    expect(isValidCode("ABC23 ")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidCode("ABC23!")).toBe(false);
    expect(isValidCode("ABC-23")).toBe(false);
    expect(isValidCode("ABC_23")).toBe(false);
  });
});

describe("normalizeCode", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeCode("  ABC234  ")).toBe("ABC234");
    expect(normalizeCode("\tABC234\n")).toBe("ABC234");
  });

  it("converts to uppercase", () => {
    expect(normalizeCode("abc234")).toBe("ABC234");
    expect(normalizeCode("aBc234")).toBe("ABC234");
  });

  it("handles already-valid codes as no-op", () => {
    const code = "XYZ789";
    expect(normalizeCode(code)).toBe(code);
  });

  it("combined: trims + uppercases", () => {
    expect(normalizeCode("  abc234  ")).toBe("ABC234");
  });

  it("handles empty string", () => {
    expect(normalizeCode("")).toBe("");
  });

  it("handles all-whitespace", () => {
    expect(normalizeCode("   ")).toBe("");
  });

  it("normalizeCode + isValidCode round-trip for valid lowercase input", () => {
    // A valid code typed in lowercase should validate after normalization
    expect(isValidCode(normalizeCode("abc234"))).toBe(true);
  });

  it("normalizeCode does NOT fix ambiguous chars (that's user error)", () => {
    // Normalizing "o" → "O" which is still ambiguous and invalid
    expect(normalizeCode("ao1234")).toBe("AO1234");
    expect(isValidCode(normalizeCode("ao1234"))).toBe(false);
  });
});

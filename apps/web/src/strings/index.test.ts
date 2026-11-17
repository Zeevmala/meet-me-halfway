import { describe, it, expect } from "vitest";
import { t } from "./index";
import type { StringKey } from "./index";
import en from "./en.json";

describe("t", () => {
  it("returns the English string for a key", () => {
    expect(t("app.title")).toBe("Meet Me Halfway");
    expect(t("common.retry")).toBe("Try again");
  });

  it("fills each placeholder from the values given", () => {
    expect(t("live.etaHours", { hours: 1, minutes: 15 })).toBe("1 h 15 min");
    expect(t("live.meetAt", { name: "Cafe Nord" })).toBe("Meet at Cafe Nord");
  });

  it("leaves a placeholder it has no value for as written", () => {
    expect(t("live.etaHours", { hours: 2 })).toBe("2 h {{minutes}} min");
  });

  it("does not treat a value as a template", () => {
    // A venue or a person can be named anything, placeholders included.
    expect(t("live.meetAt", { name: "{{name}} & $1" })).toBe(
      "Meet at {{name}} & $1",
    );
  });

  it("falls back to the key itself, never to undefined", () => {
    expect(t("live.noSuchKey" as StringKey)).toBe("live.noSuchKey");
  });
});

describe("en.json", () => {
  const leaves = (node: object, prefix = ""): [string, unknown][] =>
    Object.entries(node).flatMap(([key, value]) =>
      value !== null && typeof value === "object"
        ? leaves(value as object, `${prefix}${key}.`)
        : [[prefix + key, value] as [string, unknown]],
    );

  it("holds only non-empty strings", () => {
    for (const [key, value] of leaves(en)) {
      expect(typeof value, key).toBe("string");
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it("resolves every one of its own keys", () => {
    for (const [key, value] of leaves(en)) {
      expect(t(key as StringKey)).toBe(value);
    }
  });
});

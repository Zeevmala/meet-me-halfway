import { describe, it, expect } from "vitest";
import {
  cameraInsets,
  cornerLifts,
  fitPadding,
  NO_INSETS,
  sameInsets,
} from "./camera-insets";

// An iPhone-sized map under its two overlays: the badge at the top-left and
// the sheet across the bottom.
const PHONE = { width: 390, height: 700 };
const PHONE_BADGE = { left: 10, top: 8, width: 250, height: 56 };
const PHONE_SHEET = { left: 8, top: 492, width: 374, height: 200 };

// A wide screen, where the sheet is a card docked in the bottom corner on the
// inline-end side: the right in English, the left in Hebrew.
const DESKTOP = { width: 1280, height: 800 };
const CARD_LTR = { left: 844, top: 380, width: 420, height: 404 };
const CARD_RTL = { left: 16, top: 380, width: 420, height: 404 };

describe("cameraInsets", () => {
  it("pads a phone's bottom by the sheet and its top by the badge", () => {
    expect(
      cameraInsets(PHONE.width, PHONE.height, [PHONE_BADGE, PHONE_SHEET]),
    ).toEqual({ top: 64, right: 0, bottom: 208, left: 0 });
  });

  // Padding the bottom by a 404px card would give up the full width of the
  // screen for it; padding the side gives up only the card's own column.
  it("pads the side a docked card is on, not the bottom, in either direction", () => {
    expect(cameraInsets(DESKTOP.width, DESKTOP.height, [CARD_LTR])).toEqual({
      top: 0,
      right: 436,
      bottom: 0,
      left: 0,
    });
    expect(cameraInsets(DESKTOP.width, DESKTOP.height, [CARD_RTL])).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 436,
    });
  });

  it("takes the deepest overlay on an edge, not the sum", () => {
    const banner = { left: 10, top: 8, width: 300, height: 100 };
    expect(
      cameraInsets(PHONE.width, PHONE.height, [PHONE_BADGE, banner]).top,
    ).toBe(108);
  });

  it("ignores missing, empty and off-map overlays", () => {
    expect(
      cameraInsets(PHONE.width, PHONE.height, [
        null,
        { left: 8, top: 692, width: 374, height: 0 },
        { left: 500, top: 10, width: 100, height: 100 },
      ]),
    ).toEqual(NO_INSETS);
  });

  it("measures only the part of an overlay that is over the map", () => {
    const overhanging = { left: 8, top: 600, width: 374, height: 300 };
    expect(cameraInsets(PHONE.width, PHONE.height, [overhanging]).bottom).toBe(
      100,
    );
  });
});

describe("fitPadding", () => {
  it("adds the marker margin when there is room", () => {
    expect(
      fitPadding(
        { top: 64, right: 0, bottom: 208, left: 0 },
        40,
        PHONE.width,
        PHONE.height,
      ),
    ).toEqual({ top: 104, right: 40, bottom: 248, left: 40 });
  });

  // The production failure: a ~300px-tall phone map handed 80 + 350px of
  // padding. Mapbox refuses that fit outright, so whatever the overlays ask
  // for, a fit must keep room to frame things in.
  it("never pads a map past what a fit can use", () => {
    const padding = fitPadding(
      { top: 80, right: 0, bottom: 350, left: 0 },
      0,
      390,
      296,
    );
    const free = 296 - padding.top - padding.bottom;
    expect(free).toBeGreaterThanOrEqual(96);
    // Scaled down in proportion, so the bigger overlay keeps more padding.
    expect(padding.bottom).toBeGreaterThan(padding.top);
  });

  it("keeps at least 30% of a large dimension free", () => {
    const padding = fitPadding(
      { top: 0, right: 1000, bottom: 0, left: 0 },
      40,
      1280,
      800,
    );
    expect(1280 - padding.left - padding.right).toBeGreaterThanOrEqual(384);
  });
});

describe("sameInsets", () => {
  it("compares by value", () => {
    expect(sameInsets({ ...NO_INSETS }, NO_INSETS)).toBe(true);
    expect(sameInsets({ ...NO_INSETS, bottom: 1 }, NO_INSETS)).toBe(false);
  });
});

describe("cornerLifts", () => {
  it("lifts both bottom corners over a phone's full-width sheet", () => {
    expect(cornerLifts(PHONE.width, PHONE.height, PHONE_SHEET)).toEqual({
      left: 208,
      right: 208,
    });
  });

  it("lifts only the corner a docked card covers, in either direction", () => {
    expect(cornerLifts(DESKTOP.width, DESKTOP.height, CARD_LTR)).toEqual({
      left: 0,
      right: 420,
    });
    expect(cornerLifts(DESKTOP.width, DESKTOP.height, CARD_RTL)).toEqual({
      left: 420,
      right: 0,
    });
  });

  it("leaves the corners alone with no sheet, or one that ends above them", () => {
    expect(cornerLifts(PHONE.width, PHONE.height, null)).toEqual({
      left: 0,
      right: 0,
    });
    expect(
      cornerLifts(PHONE.width, PHONE.height, {
        left: 8,
        top: 100,
        width: 374,
        height: 200,
      }),
    ).toEqual({ left: 0, right: 0 });
  });
});

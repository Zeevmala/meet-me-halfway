/**
 * Where the camera may frame things: the map, minus the overlays drawn on it.
 *
 * The map runs full-bleed under the top bar and the bottom sheet, so a fit
 * that ignores them frames participants underneath. Fit padding used to be a
 * constant — 80px top, 350px bottom — sized for a layout #49 replaced. On a
 * phone the map it then padded was ~300px tall, less than the padding, and
 * mapbox-gl answers that by computing a negative scale, warning "Map cannot
 * fit within canvas" once, and dropping the fit: no fit of two or more points
 * ever ran on a phone, and participants sat half under the panel. The padding
 * is now measured from the overlays themselves, and clamped so it can never
 * exceed the map again.
 */

/** A box in the map's coordinate space, in CSS px (`offsetLeft`/`offsetTop`). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The share of each dimension a fit always keeps free, whatever the overlays. */
const MIN_FREE_RATIO = 0.3;
const MIN_FREE_PX = 96;

/** How wide and tall the map's own corner controls (logo, attribution) are. */
const CORNER_WIDTH_PX = 120;
const CORNER_HEIGHT_PX = 40;

type Edge = keyof Insets;

/**
 * The padding that keeps a fit clear of `overlays`.
 *
 * Each overlay is charged to the one edge whose padding hides the least of the
 * map. A sheet spanning the bottom of a phone pads the bottom; the same sheet
 * docked in a corner of a wide screen pads its side instead, because padding
 * the bottom there would give up the whole width; the badge pads the top.
 * That holds in both text directions without knowing which one is in effect —
 * the boxes say where things are.
 */
export function cameraInsets(
  width: number,
  height: number,
  overlays: readonly (Box | null)[],
): Insets {
  const insets: Record<Edge, number> = { top: 0, right: 0, bottom: 0, left: 0 };

  for (const box of overlays) {
    if (box === null) continue;
    // Only the part of the overlay that is over the map matters.
    const x0 = Math.max(0, box.left);
    const y0 = Math.max(0, box.top);
    const x1 = Math.min(width, box.left + box.width);
    const y1 = Math.min(height, box.top + box.height);
    if (x1 <= x0 || y1 <= y0) continue;

    const options: readonly { edge: Edge; depth: number; area: number }[] = [
      { edge: "top", depth: y1, area: y1 * width },
      { edge: "bottom", depth: height - y0, area: (height - y0) * width },
      { edge: "left", depth: x1, area: x1 * height },
      { edge: "right", depth: width - x0, area: (width - x0) * height },
    ];
    let best = options[0]!;
    for (const option of options) {
      if (option.area < best.area) best = option;
    }
    insets[best.edge] = Math.max(insets[best.edge], Math.round(best.depth));
  }

  return insets;
}

/**
 * The padding to hand `fitBounds`: the overlays' insets plus a margin that
 * keeps markers off the very edge of what is visible, scaled down where needed
 * so a fit always keeps `MIN_FREE` of each dimension to frame things in.
 * Mapbox drops a fit whose padding leaves no room rather than doing its best,
 * which is the failure this exists to make impossible.
 */
export function fitPadding(
  insets: Insets,
  margin: number,
  width: number,
  height: number,
): Insets {
  const [left, right] = clampPair(
    insets.left + margin,
    insets.right + margin,
    width,
  );
  const [top, bottom] = clampPair(
    insets.top + margin,
    insets.bottom + margin,
    height,
  );
  return { top, right, bottom, left };
}

function clampPair(a: number, b: number, span: number): [number, number] {
  const room = Math.max(0, span - Math.max(MIN_FREE_PX, span * MIN_FREE_RATIO));
  const total = a + b;
  if (total <= room) return [a, b];
  const scale = room / total;
  return [Math.floor(a * scale), Math.floor(b * scale)];
}

export function sameInsets(a: Insets, b: Insets): boolean {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left
  );
}

/**
 * How far the map's bottom-left and bottom-right controls must rise to clear
 * the sheet. Mapbox's terms require its wordmark and attribution to stay
 * visible, and under a full-bleed map the sheet covers whichever corners it
 * reaches: both on a phone, one of them on a wide screen — which one depends
 * on the text direction, so it is read from the sheet's box.
 */
export function cornerLifts(
  width: number,
  height: number,
  sheet: Box | null,
): { readonly left: number; readonly right: number } {
  if (sheet === null || sheet.width <= 0 || sheet.height <= 0) {
    return { left: 0, right: 0 };
  }
  // A sheet that ends above the corners leaves them alone.
  if (sheet.top + sheet.height < height - CORNER_HEIGHT_PX) {
    return { left: 0, right: 0 };
  }
  const lift = Math.max(0, Math.round(height - sheet.top));
  return {
    left: sheet.left < CORNER_WIDTH_PX ? lift : 0,
    right: sheet.left + sheet.width > width - CORNER_WIDTH_PX ? lift : 0,
  };
}

import { useEffect, useState } from "react";
import type { Box, Insets } from "../lib/camera-insets";
import {
  cameraInsets,
  cornerLifts,
  NO_INSETS,
  sameInsets,
} from "../lib/camera-insets";

export interface OverlayLayout {
  /** Camera padding that keeps a fit clear of the top bar and the sheet. */
  readonly insets: Insets;
  /** How far the map's bottom-left / bottom-right controls rise to clear the sheet. */
  readonly liftLeft: number;
  readonly liftRight: number;
}

const NONE: OverlayLayout = { insets: NO_INSETS, liftLeft: 0, liftRight: 0 };

/**
 * Layout boxes, not `getBoundingClientRect`: the cards slide up into place, and
 * a measurement taken mid-animation would be off by the transform.
 */
function boxOf(element: HTMLElement | null): Box | null {
  if (element === null) return null;
  return {
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
  };
}

/**
 * The overlays' footprint on the map, re-measured whenever any of them — or
 * the map — changes size.
 *
 * `frame` is the full-bleed page the map fills; `topbar` and `sheet` are its
 * direct children, so their offsets are already in the map's coordinates. The
 * result only changes when a number does, so it can be a prop of the memoised
 * map without re-running its effects on every GPS fix.
 */
export function useOverlayInsets(
  frame: HTMLElement | null,
  topbar: HTMLElement | null,
  sheet: HTMLElement | null,
): OverlayLayout {
  const [layout, setLayout] = useState<OverlayLayout>(NONE);

  useEffect(() => {
    if (frame === null) return;

    const measure = () => {
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      const sheetBox = boxOf(sheet);
      const insets = cameraInsets(width, height, [boxOf(topbar), sheetBox]);
      const lifts = cornerLifts(width, height, sheetBox);
      setLayout((previous) =>
        sameInsets(previous.insets, insets) &&
        previous.liftLeft === lifts.left &&
        previous.liftRight === lifts.right
          ? previous
          : { insets, liftLeft: lifts.left, liftRight: lifts.right },
      );
    };

    measure();
    window.addEventListener("resize", measure);
    // jsdom has no ResizeObserver; the window listener alone still measures.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    for (const element of [frame, topbar, sheet]) {
      if (element !== null) observer?.observe(element);
    }

    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [frame, topbar, sheet]);

  return layout;
}

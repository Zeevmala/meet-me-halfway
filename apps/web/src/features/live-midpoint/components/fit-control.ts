import type { IControl } from "mapbox-gl";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * "Show everyone" — the map control a phone actually needs.
 *
 * It replaces Mapbox's own. The zoom buttons repeat a pinch (they stay where
 * there is a mouse), the compass only undid a rotation this map no longer
 * allows, and GeolocateControl ran a geolocation of its own and drew Mapbox's
 * blue dot next to participant 2's blue marker. On iOS their icons were blank
 * as well: dark data-URI backgrounds, lightened with `filter: invert(1)`
 * inside a `backdrop-filter` group, which WebKit paints as nothing. This icon
 * is an inline SVG drawn in `currentColor`, so nothing has to invert it.
 *
 * Highlighted while the user holds the camera: a gesture stops the map
 * refitting as people move, and this is how they hand it back.
 */
export class FitControl implements IControl {
  private container: HTMLDivElement | null = null;
  private button: HTMLButtonElement | null = null;
  private attention = false;

  constructor(
    private readonly label: string,
    private readonly onFit: () => void,
  ) {}

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className = "mapboxgl-ctrl mapboxgl-ctrl-group";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "live-fit-btn";
    button.title = this.label;
    button.setAttribute("aria-label", this.label);
    button.appendChild(fitIcon());
    button.addEventListener("click", this.handleClick);
    button.classList.toggle("live-fit-btn--attention", this.attention);

    container.appendChild(button);
    this.container = container;
    this.button = button;
    return container;
  }

  onRemove(): void {
    this.button?.removeEventListener("click", this.handleClick);
    this.container?.remove();
    this.container = null;
    this.button = null;
  }

  setAttention(on: boolean): void {
    this.attention = on;
    this.button?.classList.toggle("live-fit-btn--attention", on);
  }

  private readonly handleClick = () => {
    this.onFit();
  };
}

/** Four frame corners around a dot: everything brought into view. */
function fitIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const corners = document.createElementNS(SVG_NS, "path");
  corners.setAttribute(
    "d",
    "M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3",
  );
  corners.setAttribute("fill", "none");
  corners.setAttribute("stroke", "currentColor");
  corners.setAttribute("stroke-width", "2");
  corners.setAttribute("stroke-linecap", "round");
  corners.setAttribute("stroke-linejoin", "round");

  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", "12");
  dot.setAttribute("cy", "12");
  dot.setAttribute("r", "2.5");
  dot.setAttribute("fill", "currentColor");

  svg.append(corners, dot);
  return svg;
}

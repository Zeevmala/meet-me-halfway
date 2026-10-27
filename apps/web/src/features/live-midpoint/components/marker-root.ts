/**
 * The element handed to `mapboxgl.Marker`, wrapping the one we style.
 *
 * Mapbox owns the element it is given. It positions it through the
 * `mapboxgl-marker` class (`position: absolute; top: 0; left: 0`), sets its
 * `transform` on every frame, and writes an inline `opacity` on it whenever
 * fog, terrain or the globe projection is in play. Styling that element
 * directly fought the first two outright — `.live-marker { position:
 * relative }` overrode the absolute positioning, so each marker was drawn
 * lower by the height of the markers before it, and `VenueMarker` replaced the
 * whole class list, Mapbox's classes included — and left
 * `.live-marker--stale`'s dimming one style change away from being overridden
 * by the third.
 *
 * So Mapbox gets a bare root, and everything visual lives on its child. The
 * root shrink-wraps the child, so the `center` anchor still lands on the dot.
 */
export function markerRoot(visual: HTMLElement): HTMLDivElement {
  const root = document.createElement("div");
  root.appendChild(visual);
  return root;
}

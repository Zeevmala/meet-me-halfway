/**
 * Mapbox Directions client. Mirrors places-api: failures are returned as a
 * typed Result rather than swallowed, so the resource layer can back off.
 */
import type { LatLng } from "./geo-math";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyResponse, classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { RouteInfo, TravelProfile } from "../graph/types";

interface DirectionsResponse {
  routes?: {
    geometry: RouteInfo["geometry"];
    duration: number;
    distance: number;
  }[];
}

export type FetchRoute = (
  from: LatLng,
  to: LatLng,
  profile: TravelProfile,
  signal: AbortSignal,
) => Promise<Result<RouteInfo | null, ResourceError>>;

/**
 * Bind a Directions client to a token.
 *
 * The token arrives as an argument rather than being read from
 * `import.meta.env` here, so the composition root owns every credential and a
 * test can exercise this module without a build-time substitution.
 *
 * The returned function resolves the first route, `null` when Mapbox has no
 * route between the two points (a legitimate answer, not a failure), or a
 * transport failure.
 */
export function createDirectionsClient(accessToken: string): FetchRoute {
  return async function fetchRoute(
    from: LatLng,
    to: LatLng,
    profile: TravelProfile,
    signal: AbortSignal,
  ): Promise<Result<RouteInfo | null, ResourceError>> {
    // `overview=simplified`, not `full`. Full geometry is commonly 1,500–4,000
    // coordinate pairs for an urban route — 150–400 KB as parsed GeoJSON, times
    // five slots, doubled again by the resource's last-good buffer. Simplified
    // cuts roughly 90% of that, and the difference is not visible at the zoom
    // `fitBounds` settles on (maxZoom 16, with 350px of bottom padding for the
    // card): the route is drawn as a 4px line, well above the residual
    // simplification error.
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?geometries=geojson&overview=simplified&access_token=${accessToken}`;

    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        console.warn(`[directions-api] HTTP ${res.status}: ${res.statusText}`);
        return err(classifyResponse(res));
      }

      const data: DirectionsResponse = await res.json();
      const route = data.routes?.[0];
      if (!route) return ok(null);

      return ok({
        geometry: route.geometry,
        duration: route.duration,
        distance: route.distance,
      });
    } catch (thrown) {
      // Abort means a newer request superseded this one, not a failure.
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        throw thrown;
      }
      return err(classifyThrown(thrown));
    }
  };
}

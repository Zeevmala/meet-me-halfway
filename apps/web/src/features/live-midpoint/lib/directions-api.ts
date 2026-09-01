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

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

interface DirectionsResponse {
  routes?: {
    geometry: RouteInfo["geometry"];
    duration: number;
    distance: number;
  }[];
}

/**
 * @returns the first route, `null` when Mapbox has no route between the two
 *   points (a legitimate answer, not a failure), or a transport failure.
 */
export async function fetchRoute(
  from: LatLng,
  to: LatLng,
  profile: TravelProfile,
  signal: AbortSignal,
): Promise<Result<RouteInfo | null, ResourceError>> {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

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
}

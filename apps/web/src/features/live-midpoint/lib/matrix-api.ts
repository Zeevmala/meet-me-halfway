/**
 * Mapbox Matrix client: travel times from every source to every destination
 * in one request. Mirrors `directions-api`: a typed Result, never a throw
 * (except the abort, which is the caller superseding itself).
 */
import type { LatLng } from "./geo-math";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyResponse, classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { TravelProfile } from "../graph/types";

/** The API's ceiling on sources plus destinations, per request. */
export const MATRIX_MAX_COORDINATES = 25;

export interface MatrixResult {
  /** `durations[i][j]`: seconds from source `i` to destination `j`; `null` where there is no route. */
  readonly durations: readonly (readonly (number | null)[])[];
  /** Each destination as the router snapped it to the road network. */
  readonly destinations: readonly LatLng[];
}

export type FetchMatrix = (
  sources: readonly LatLng[],
  destinations: readonly LatLng[],
  profile: TravelProfile,
  signal: AbortSignal,
) => Promise<Result<MatrixResult, ResourceError>>;

interface MatrixResponse {
  code?: string;
  durations?: (number | null)[][];
  destinations?: { location?: [number, number] }[];
}

/**
 * A 200 whose body is not a matrix for what was asked. Reported as a 422: the
 * request is what is wrong, so it is neither retried nor held against the
 * breaker.
 */
const MALFORMED: ResourceError = { kind: "HTTP", status: 422 };

/** Six decimals is ~0.1 m — beyond GPS, and it keeps the URL short. */
const coordinate = (point: LatLng): string =>
  `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;

const indices = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => from + i).join(";");

export function createMatrixClient(accessToken: string): FetchMatrix {
  return async function fetchMatrix(
    sources,
    destinations,
    profile,
    signal,
  ): Promise<Result<MatrixResult, ResourceError>> {
    if (
      sources.length === 0 ||
      destinations.length === 0 ||
      sources.length + destinations.length > MATRIX_MAX_COORDINATES
    ) {
      return err(MALFORMED);
    }

    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/` +
      [...sources, ...destinations].map(coordinate).join(";") +
      `?sources=${indices(0, sources.length)}` +
      `&destinations=${indices(sources.length, destinations.length)}` +
      `&annotations=duration&access_token=${accessToken}`;

    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        console.warn(`[matrix-api] HTTP ${res.status}: ${res.statusText}`);
        return err(classifyResponse(res));
      }

      const data: MatrixResponse = await res.json();
      const durations = data.durations;
      const snapped = data.destinations;
      if (
        data.code !== "Ok" ||
        !Array.isArray(durations) ||
        !Array.isArray(snapped) ||
        durations.length !== sources.length ||
        snapped.length !== destinations.length ||
        durations.some((row) => row.length !== destinations.length)
      ) {
        return err(MALFORMED);
      }

      return ok({
        durations,
        // A destination the router could not place keeps the coordinate that
        // was asked for; its durations are null, so it is never chosen.
        destinations: snapped.map((destination, j) => {
          const location = destination.location;
          const asked = destinations[j] as LatLng;
          return location ? { lat: location[1], lng: location[0] } : asked;
        }),
      });
    } catch (thrown) {
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        throw thrown;
      }
      return err(classifyThrown(thrown));
    }
  };
}

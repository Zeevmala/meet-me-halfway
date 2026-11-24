/**
 * Mapbox Matrix client: travel times from every source to every destination
 * in one request. Mirrors directions-api — the token arrives as an argument,
 * failures come back as a typed Result.
 */
import type { LatLng } from "./geo-math";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
import { classifyResponse, classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { TravelProfile } from "../graph/types";

/**
 * Mapbox's ceiling on coordinates per request, sources and destinations
 * together, for the `driving` and `walking` profiles. (`driving-traffic` is
 * capped at 10, which is why the matrix does not use it.)
 */
export const MATRIX_MAX_COORDINATES = 25;

export interface MatrixResult {
  /** `durations[source][destination]`, seconds; `null` where there is no route. */
  readonly durations: readonly (readonly (number | null)[])[];
  /** Each destination as Mapbox snapped it to the road network. */
  readonly snapped: readonly LatLng[];
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
  destinations?: ({ location?: [number, number] } | null)[];
}

function coordinate(point: LatLng): string {
  // Six decimals is ~0.1 m; more only lengthens the URL.
  return `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`;
}

function indices(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => from + i).join(";");
}

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
      // A caller's bug, not an outage: shaped as the 422 Mapbox would send, so
      // it is neither retried nor counted against the breaker.
      return err({ kind: "HTTP", status: 422 });
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
      const rows = data.durations;
      if (
        data.code !== "Ok" ||
        rows === undefined ||
        rows.length !== sources.length ||
        rows.some((row) => row.length !== destinations.length)
      ) {
        return err({ kind: "HTTP", status: 502 });
      }

      const snapped = destinations.map((asked, i) => {
        const location = data.destinations?.[i]?.location;
        // Checked: this point is published to the session, and a record
        // with a bad number in it is refused whole — position included.
        return location !== undefined &&
          Number.isFinite(location[0]) &&
          Number.isFinite(location[1])
          ? { lat: location[1], lng: location[0] }
          : asked;
      });
      return ok({ durations: rows, snapped });
    } catch (thrown) {
      // Abort means a newer request superseded this one, not a failure.
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        throw thrown;
      }
      return err(classifyThrown(thrown));
    }
  };
}

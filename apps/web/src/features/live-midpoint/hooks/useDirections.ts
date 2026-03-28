import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance } from "../lib/geo-math";

export type TravelProfile = "driving" | "walking";

export interface RouteInfo {
  geometry: GeoJSON.LineString;
  duration: number; // seconds
  distance: number; // meters
}

export interface DirectionsState {
  routes: (RouteInfo | null)[];
  loading: boolean;
  error: string | null;
}

const INITIAL_DEBOUNCE_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const MOVEMENT_THRESHOLD_M = 200;
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

async function fetchRoute(
  from: LatLng,
  to: LatLng,
  signal: AbortSignal,
  profile: TravelProfile = "driving",
): Promise<RouteInfo | null> {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url, { signal });
  if (!res.ok) {
    console.warn(`[useDirections] HTTP ${res.status}: ${res.statusText}`);
    if (res.status === 429) throw new Error("RATE_LIMITED");
    return null;
  }

  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) return null;

  return {
    geometry: route.geometry as GeoJSON.LineString,
    duration: route.duration as number,
    distance: route.distance as number,
  };
}

/**
 * Fetch Mapbox Directions routes for N participants → destination
 * with a 3-second debounce. Skips refetch when all positions moved
 * less than 200m and profile is unchanged.
 *
 * With 5 participants and 3s debounce, worst case is ~100 req/min
 * (well within Mapbox free tier of 300 req/min).
 *
 * @param positions - Array of participant positions
 * @param destination - Selected venue or midpoint
 * @param profile - Travel mode: "driving" (default) or "walking"
 */
export function useDirections(
  positions: (LatLng | null)[],
  destination: LatLng | null,
  profile: TravelProfile = "driving",
): DirectionsState {
  const [routes, setRoutes] = useState<(RouteInfo | null)[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const backoffRef = useRef(INITIAL_DEBOUNCE_MS);
  const lastFetchRef = useRef<{
    positions: LatLng[];
    dest: LatLng;
    profile: TravelProfile;
  } | null>(null);

  // Serialize positions for dependency tracking
  const posKey = JSON.stringify(positions);

  useEffect(() => {
    const validPositions = positions.filter((p): p is LatLng => p !== null);
    if (validPositions.length === 0 || !destination) return;

    // Skip refetch if insufficient movement and same profile
    if (lastFetchRef.current) {
      const prev = lastFetchRef.current;
      if (
        prev.positions.length === validPositions.length &&
        prev.profile === profile &&
        haversineDistance(destination, prev.dest) < MOVEMENT_THRESHOLD_M &&
        validPositions.every(
          (pos, i) =>
            haversineDistance(pos, prev.positions[i]) < MOVEMENT_THRESHOLD_M,
        )
      ) {
        return;
      }
    }

    // Clear previous debounce timer
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      // Cancel any in-flight requests
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      const { signal } = abortRef.current;

      setLoading(true);

      try {
        const results = await Promise.all(
          validPositions.map((pos) =>
            fetchRoute(pos, destination, signal, profile),
          ),
        );

        if (!signal.aborted) {
          setRoutes(results);
          setError(null);
          backoffRef.current = INITIAL_DEBOUNCE_MS;
          lastFetchRef.current = {
            positions: validPositions,
            dest: destination,
            profile,
          };
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!signal.aborted) {
          const isRateLimit =
            err instanceof Error && err.message === "RATE_LIMITED";
          if (isRateLimit) {
            backoffRef.current = Math.min(
              backoffRef.current * BACKOFF_MULTIPLIER,
              MAX_BACKOFF_MS,
            );
          }
          console.warn("[useDirections] fetch failed:", err);
          setError("DIRECTIONS_FAILED");
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, backoffRef.current);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [posKey, destination, profile]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { routes, loading, error };
}

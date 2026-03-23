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
  routeA: RouteInfo | null;
  routeB: RouteInfo | null;
  loading: boolean;
  error: string | null;
}

const DEBOUNCE_MS = 3_000;
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
 * Fetch dual Mapbox Directions routes (A→destination, B→destination)
 * with a 3-second debounce. Skips refetch when all positions moved
 * less than 200m and profile is unchanged.
 *
 * @param posA - Participant A position
 * @param posB - Participant B position
 * @param destination - Selected venue or midpoint
 * @param profile - Travel mode: "driving" (default) or "walking"
 */
export function useDirections(
  posA: LatLng | null,
  posB: LatLng | null,
  destination: LatLng | null,
  profile: TravelProfile = "driving",
): DirectionsState {
  const [routeA, setRouteA] = useState<RouteInfo | null>(null);
  const [routeB, setRouteB] = useState<RouteInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastFetchRef = useRef<{
    posA: LatLng;
    posB: LatLng;
    dest: LatLng;
    profile: TravelProfile;
  } | null>(null);

  useEffect(() => {
    if (!posA || !posB || !destination) return;

    // Skip refetch if insufficient movement and same profile
    if (lastFetchRef.current) {
      const prev = lastFetchRef.current;
      const movedA = haversineDistance(posA, prev.posA);
      const movedB = haversineDistance(posB, prev.posB);
      const movedDest = haversineDistance(destination, prev.dest);
      if (
        movedA < MOVEMENT_THRESHOLD_M &&
        movedB < MOVEMENT_THRESHOLD_M &&
        movedDest < MOVEMENT_THRESHOLD_M &&
        profile === prev.profile
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
        const [rA, rB] = await Promise.all([
          fetchRoute(posA, destination, signal, profile),
          fetchRoute(posB, destination, signal, profile),
        ]);

        if (!signal.aborted) {
          setRouteA(rA);
          setRouteB(rB);
          setError(null);
          lastFetchRef.current = { posA, posB, dest: destination, profile };
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (!signal.aborted) {
          console.warn("[useDirections] fetch failed:", err);
          setError("DIRECTIONS_FAILED");
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [posA, posB, destination, profile]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { routeA, routeB, loading, error };
}

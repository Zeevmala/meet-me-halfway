import { useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";

export interface RouteInfo {
  geometry: GeoJSON.LineString;
  duration: number; // seconds
  distance: number; // meters
}

export interface DirectionsState {
  routeA: RouteInfo | null;
  routeB: RouteInfo | null;
  loading: boolean;
}

const DEBOUNCE_MS = 3_000;
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;

async function fetchRoute(
  from: LatLng,
  to: LatLng,
  signal: AbortSignal,
): Promise<RouteInfo | null> {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url, { signal });
  if (!res.ok) return null;

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
 * Fetch dual Mapbox Directions routes (A→midpoint, B→midpoint)
 * with a 3-second debounce to avoid spamming the API on every
 * watchPosition tick.
 */
export function useDirections(
  posA: LatLng | null,
  posB: LatLng | null,
  midpoint: LatLng | null,
): DirectionsState {
  const [routeA, setRouteA] = useState<RouteInfo | null>(null);
  const [routeB, setRouteB] = useState<RouteInfo | null>(null);
  const [loading, setLoading] = useState(false);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!posA || !posB || !midpoint) return;

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
          fetchRoute(posA, midpoint, signal),
          fetchRoute(posB, midpoint, signal),
        ]);

        if (!signal.aborted) {
          setRouteA(rA);
          setRouteB(rB);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[Directions] Fetch failed:", err);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [posA, posB, midpoint]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { routeA, routeB, loading };
}

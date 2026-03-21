import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance } from "../lib/geo-math";
import { searchNearbyVenues } from "../lib/places-api";
import { rankVenues } from "../lib/venue-ranking";
import type { RankedVenue } from "../lib/venue-ranking";

export interface VenueSearchState {
  venues: RankedVenue[];
  loading: boolean;
  error: string | null;
}

const STABILITY_DELAY_MS = 5_000;
const CACHE_RADIUS_M = 100;
const SEARCH_RADIUS_M = 1_000;

/**
 * Search for venues near the midpoint once it has been stable for 5 seconds.
 * Caches results when the midpoint moves less than 100m from last search center.
 * Gracefully skips if VITE_GOOGLE_PLACES_API_KEY is not set.
 */
export function useVenueSearch(midpoint: LatLng | null): VenueSearchState {
  const [venues, setVenues] = useState<RankedVenue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSearchCenterRef = useRef<LatLng | null>(null);

  const doSearch = useCallback(async (center: LatLng) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    setLoading(true);
    setError(null);

    try {
      const places = await searchNearbyVenues(center, SEARCH_RADIUS_M, signal);
      if (!signal.aborted) {
        const ranked = rankVenues(places, center, 5);
        setVenues(ranked);
        lastSearchCenterRef.current = center;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!abortRef.current?.signal.aborted) {
        setError("Failed to search for venues");
      }
    } finally {
      if (!abortRef.current?.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!midpoint) {
      setVenues([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Skip if API key not set
    if (!import.meta.env.VITE_GOOGLE_PLACES_API_KEY) return;

    // Cache hit: midpoint within 100m of last search
    if (
      lastSearchCenterRef.current &&
      haversineDistance(midpoint, lastSearchCenterRef.current) < CACHE_RADIUS_M
    ) {
      return;
    }

    // Clear previous stability timer
    if (stableTimerRef.current) clearTimeout(stableTimerRef.current);

    // Wait for midpoint to stabilize (5s)
    stableTimerRef.current = setTimeout(() => {
      doSearch(midpoint);
    }, STABILITY_DELAY_MS);

    return () => {
      if (stableTimerRef.current) clearTimeout(stableTimerRef.current);
    };
  }, [midpoint, doSearch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stableTimerRef.current) clearTimeout(stableTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return { venues, loading, error };
}

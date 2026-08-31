import { useCallback, useEffect, useRef, useState } from "react";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance } from "../lib/geo-math";
import { searchNearbyVenues } from "../lib/places-api";
import { rankVenues } from "../lib/venue-ranking";
import { classifyThrown } from "../../../core/dag/errors";
import type { ResourceError } from "../../../core/dag/errors";
import type { RankedVenue } from "../lib/venue-ranking";

export interface VenueSearchState {
  venues: RankedVenue[];
  loading: boolean;
  error: ResourceError | null;
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
  const [error, setError] = useState<ResourceError | null>(null);

  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSearchCenterRef = useRef<LatLng | null>(null);

  const doSearch = useCallback(async (center: LatLng) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setLoading(true);
    setError(null);

    try {
      const result = await searchNearbyVenues(center, SEARCH_RADIUS_M, signal);
      // Every guard below reads the signal captured for *this* call. Reading
      // abortRef.current instead consults whichever controller is current, so
      // a superseded call would clear `loading` out from under the newer
      // request that replaced it — the loading indicator flickered off while
      // a search was still in flight.
      if (signal.aborted) return;
      if (result.ok) {
        setVenues(rankVenues(result.value, center, 5));
        lastSearchCenterRef.current = center;
      } else {
        setError(result.error);
      }
    } catch (thrown) {
      if (thrown instanceof DOMException && thrown.name === "AbortError") {
        return;
      }
      if (!signal.aborted) setError(classifyThrown(thrown));
    } finally {
      if (!signal.aborted) setLoading(false);
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

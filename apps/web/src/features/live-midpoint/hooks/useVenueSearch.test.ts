import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVenueSearch } from "./useVenueSearch";
import type { LatLng } from "../lib/geo-math";
import type { PlaceResult } from "../lib/venue-ranking";

// ── Mock places-api ──
const mockSearchNearbyVenues = vi.fn();
vi.mock("../lib/places-api", () => ({
  searchNearbyVenues: (...args: unknown[]) => mockSearchNearbyVenues(...args),
}));

// ── Mock venue-ranking ──
vi.mock("../lib/venue-ranking", () => ({
  rankVenues: (places: PlaceResult[], _center: LatLng, limit: number) =>
    places.slice(0, limit).map((p, i) => ({ ...p, score: 1 - i * 0.1 })),
}));

const MIDPOINT: LatLng = { lat: 31.925, lng: 34.995 };
// Within 100m of MIDPOINT
const MIDPOINT_CLOSE: LatLng = { lat: 31.9251, lng: 34.9951 };
// Beyond 100m of MIDPOINT
const MIDPOINT_FAR: LatLng = { lat: 31.935, lng: 35.005 };

const MOCK_PLACES: PlaceResult[] = [
  {
    id: "place1",
    displayName: "Cafe One",
    location: { lat: 31.926, lng: 34.996 },
    rating: 4.5,
    userRatingCount: 200,
    openNow: true,
    types: ["cafe"],
  },
  {
    id: "place2",
    displayName: "Bar Two",
    location: { lat: 31.924, lng: 34.994 },
    rating: 4.2,
    userRatingCount: 150,
    openNow: false,
    types: ["bar"],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Ensure API key is set so the hook doesn't skip
  vi.stubEnv("VITE_GOOGLE_PLACES_API_KEY", "test-api-key");
  mockSearchNearbyVenues.mockResolvedValue(MOCK_PLACES);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useVenueSearch", () => {
  it("returns empty venues when midpoint is null", () => {
    const { result } = renderHook(() => useVenueSearch(null));

    expect(result.current.venues).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("skips search when API key is not set", () => {
    vi.stubEnv("VITE_GOOGLE_PLACES_API_KEY", "");

    const { result } = renderHook(() => useVenueSearch(MIDPOINT));

    // Even after stability delay, no search should happen
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockSearchNearbyVenues).not.toHaveBeenCalled();
    expect(result.current.venues).toEqual([]);
  });

  it("searches after 5s stability delay", async () => {
    const { result } = renderHook(() => useVenueSearch(MIDPOINT));

    // Before stability delay
    expect(mockSearchNearbyVenues).not.toHaveBeenCalled();

    // Advance past stability delay
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockSearchNearbyVenues).toHaveBeenCalledTimes(1);
    expect(mockSearchNearbyVenues).toHaveBeenCalledWith(
      MIDPOINT,
      1000,
      expect.any(AbortSignal),
    );
    expect(result.current.venues).toHaveLength(2);
    expect(result.current.venues[0].displayName).toBe("Cafe One");
  });

  it("caches result when midpoint moves < 100m", async () => {
    const { result, rerender } = renderHook(({ mid }) => useVenueSearch(mid), {
      initialProps: { mid: MIDPOINT },
    });

    // First search
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockSearchNearbyVenues).toHaveBeenCalledTimes(1);

    // Small movement — should use cache
    mockSearchNearbyVenues.mockClear();
    rerender({ mid: MIDPOINT_CLOSE });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockSearchNearbyVenues).not.toHaveBeenCalled();
    expect(result.current.venues).toHaveLength(2); // still has cached results
  });

  it("re-searches when midpoint moves > 100m", async () => {
    const { rerender } = renderHook(({ mid }) => useVenueSearch(mid), {
      initialProps: { mid: MIDPOINT },
    });

    // First search
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockSearchNearbyVenues).toHaveBeenCalledTimes(1);

    // Large movement — should trigger new search
    mockSearchNearbyVenues.mockClear();
    rerender({ mid: MIDPOINT_FAR });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockSearchNearbyVenues).toHaveBeenCalledTimes(1);
  });

  it("handles search error gracefully", async () => {
    mockSearchNearbyVenues.mockRejectedValueOnce(new Error("API error"));

    const { result } = renderHook(() => useVenueSearch(MIDPOINT));

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.error).toBe("Failed to search for venues");
    expect(result.current.venues).toEqual([]);
  });

  it("aborts previous request on rapid midpoint changes", async () => {
    const { rerender } = renderHook(({ mid }) => useVenueSearch(mid), {
      initialProps: { mid: MIDPOINT },
    });

    // Don't wait for stability — change midpoint
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    rerender({ mid: MIDPOINT_FAR });

    // Only one fetch after final stability
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(mockSearchNearbyVenues).toHaveBeenCalledTimes(1);
    // Should be called with the latest midpoint
    expect(mockSearchNearbyVenues).toHaveBeenCalledWith(
      MIDPOINT_FAR,
      1000,
      expect.any(AbortSignal),
    );
  });

  it("clears venues when midpoint becomes null", async () => {
    const { result, rerender } = renderHook(({ mid }) => useVenueSearch(mid), {
      initialProps: { mid: MIDPOINT as LatLng | null },
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.venues).toHaveLength(2);

    rerender({ mid: null });

    expect(result.current.venues).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

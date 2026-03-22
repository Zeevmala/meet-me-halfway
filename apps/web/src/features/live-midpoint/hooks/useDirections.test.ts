import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDirections } from "./useDirections";
import type { LatLng } from "../lib/geo-math";

// ── Mock import.meta.env ──
vi.stubEnv("VITE_MAPBOX_TOKEN", "pk.test_token");

// ── Mock fetch ──
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeRouteResponse(distance: number, duration: number) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        routes: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [34.78, 32.08],
                [34.79, 32.09],
              ],
            },
            distance,
            duration,
          },
        ],
      }),
  };
}

const TEL_AVIV: LatLng = { lat: 32.08, lng: 34.78 };
const JERUSALEM: LatLng = { lat: 31.77, lng: 35.21 };
const MIDPOINT: LatLng = { lat: 31.925, lng: 34.995 };

// Positions moved >200m from above
const TEL_AVIV_MOVED: LatLng = { lat: 32.085, lng: 34.785 };
const JERUSALEM_MOVED: LatLng = { lat: 31.775, lng: 35.215 };
const MIDPOINT_MOVED: LatLng = { lat: 31.93, lng: 35.0 };

// Positions moved <200m (within threshold)
const TEL_AVIV_CLOSE: LatLng = { lat: 32.0801, lng: 34.7801 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockFetch.mockResolvedValue(makeRouteResponse(50000, 3600));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDirections", () => {
  it("returns null routes when positions are null", () => {
    const { result } = renderHook(() => useDirections(null, null, null));

    expect(result.current.routeA).toBeNull();
    expect(result.current.routeB).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("fetches dual routes after 3s debounce", async () => {
    mockFetch.mockResolvedValue(makeRouteResponse(50000, 3600));

    const { result } = renderHook(() =>
      useDirections(TEL_AVIV, JERUSALEM, MIDPOINT),
    );

    // Before debounce
    expect(mockFetch).not.toHaveBeenCalled();

    // Advance past debounce
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.routeA).not.toBeNull();
    expect(result.current.routeB).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("skips refetch when movement < 200m", async () => {
    const { rerender } = renderHook(
      ({ posA, posB, dest }) => useDirections(posA, posB, dest),
      {
        initialProps: {
          posA: TEL_AVIV,
          posB: JERUSALEM,
          dest: MIDPOINT,
        },
      },
    );

    // First fetch
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Small movement — should NOT trigger refetch
    mockFetch.mockClear();
    rerender({
      posA: TEL_AVIV_CLOSE,
      posB: JERUSALEM,
      dest: MIDPOINT,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refetches when movement > 200m", async () => {
    const { rerender } = renderHook(
      ({ posA, posB, dest }) => useDirections(posA, posB, dest),
      {
        initialProps: {
          posA: TEL_AVIV,
          posB: JERUSALEM,
          dest: MIDPOINT,
        },
      },
    );

    // First fetch
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Large movement — should trigger refetch
    mockFetch.mockClear();
    rerender({
      posA: TEL_AVIV_MOVED,
      posB: JERUSALEM_MOVED,
      dest: MIDPOINT_MOVED,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("refetches when profile changes", async () => {
    const { rerender } = renderHook(
      ({ profile }: { profile: "driving" | "walking" }) =>
        useDirections(TEL_AVIV, JERUSALEM, MIDPOINT, profile),
      { initialProps: { profile: "driving" as "driving" | "walking" } },
    );

    // First fetch
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Change profile
    mockFetch.mockClear();
    rerender({ profile: "walking" });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify walking profile used in URL
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("mapbox/walking/");
  });

  it("sets error on non-abort fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() =>
      useDirections(TEL_AVIV, JERUSALEM, MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.error).toBe("Failed to fetch directions.");
  });

  it("cleans up abort controller and timer on unmount", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    const { unmount } = renderHook(() =>
      useDirections(TEL_AVIV, JERUSALEM, MIDPOINT),
    );

    // Start debounce but don't complete
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    unmount();

    // Timer cleanup handled by useEffect cleanup — no fetch should happen
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    // Fetch was never called because timer was cleared
    expect(mockFetch).not.toHaveBeenCalled();

    abortSpy.mockRestore();
  });
});

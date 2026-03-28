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
const HAIFA: LatLng = { lat: 32.794, lng: 34.9896 };
const BEER_SHEVA: LatLng = { lat: 31.2518, lng: 34.7913 };
const EILAT: LatLng = { lat: 29.5577, lng: 34.9519 };
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
  it("returns empty routes when positions are empty", () => {
    const { result } = renderHook(() => useDirections([], null));

    expect(result.current.routes).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("returns empty routes when all positions are null", () => {
    const { result } = renderHook(() => useDirections([null, null], MIDPOINT));

    expect(result.current.routes).toEqual([]);
  });

  it("fetches routes for 2 participants after 3s debounce", async () => {
    mockFetch.mockResolvedValue(makeRouteResponse(50000, 3600));

    const { result } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM], MIDPOINT),
    );

    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.current.routes).toHaveLength(2);
    expect(result.current.routes[0]).not.toBeNull();
    expect(result.current.routes[1]).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("fetches routes for 5 participants", async () => {
    mockFetch.mockResolvedValue(makeRouteResponse(50000, 3600));

    const { result } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM, HAIFA, BEER_SHEVA, EILAT], MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result.current.routes).toHaveLength(5);
  });

  it("skips refetch when movement < 200m", async () => {
    const { rerender } = renderHook(
      ({ positions, dest }: { positions: (LatLng | null)[]; dest: LatLng }) =>
        useDirections(positions, dest),
      {
        initialProps: {
          positions: [TEL_AVIV, JERUSALEM],
          dest: MIDPOINT,
        },
      },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();
    rerender({
      positions: [TEL_AVIV_CLOSE, JERUSALEM],
      dest: MIDPOINT,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refetches when movement > 200m", async () => {
    const { rerender } = renderHook(
      ({ positions, dest }: { positions: (LatLng | null)[]; dest: LatLng }) =>
        useDirections(positions, dest),
      {
        initialProps: {
          positions: [TEL_AVIV, JERUSALEM],
          dest: MIDPOINT,
        },
      },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();
    rerender({
      positions: [TEL_AVIV_MOVED, JERUSALEM_MOVED],
      dest: MIDPOINT_MOVED,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("refetches when participant count changes", async () => {
    const { rerender } = renderHook(
      ({ positions, dest }: { positions: (LatLng | null)[]; dest: LatLng }) =>
        useDirections(positions, dest),
      {
        initialProps: {
          positions: [TEL_AVIV, JERUSALEM] as (LatLng | null)[],
          dest: MIDPOINT,
        },
      },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();
    rerender({
      positions: [TEL_AVIV, JERUSALEM, HAIFA],
      dest: MIDPOINT,
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("refetches when profile changes", async () => {
    const { rerender } = renderHook(
      ({ profile }: { profile: "driving" | "walking" }) =>
        useDirections([TEL_AVIV, JERUSALEM], MIDPOINT, profile),
      { initialProps: { profile: "driving" as "driving" | "walking" } },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    mockFetch.mockClear();
    rerender({ profile: "walking" });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("mapbox/walking/");
  });

  it("sets error on non-abort fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM], MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.error).toBe("DIRECTIONS_FAILED");
  });

  it("returns null routes on HTTP 500 response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const { result } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM], MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.routes[0]).toBeNull();
    expect(result.current.routes[1]).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("sets error on HTTP 429 rate limit", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const { result } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM], MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.error).toBe("DIRECTIONS_FAILED");
  });

  it("backs off exponentially on 429 responses", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const { rerender } = renderHook(
      ({ positions }: { positions: (LatLng | null)[] }) =>
        useDirections(positions, MIDPOINT),
      {
        initialProps: { positions: [TEL_AVIV, JERUSALEM] as (LatLng | null)[] },
      },
    );

    // First attempt fires at normal 3s debounce
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Move positions so the hook wants to refetch
    mockFetch.mockClear();
    rerender({ positions: [TEL_AVIV_MOVED, JERUSALEM_MOVED] });

    // At 3s the backed-off timer (6s) should NOT have fired yet
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    // At 6s (doubled backoff) it should fire
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  it("resets backoff after successful response", async () => {
    // First call: 429
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const { rerender } = renderHook(
      ({ positions }: { positions: (LatLng | null)[] }) =>
        useDirections(positions, MIDPOINT),
      {
        initialProps: { positions: [TEL_AVIV, JERUSALEM] as (LatLng | null)[] },
      },
    );

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    // Second call: success with moved positions
    mockFetch.mockResolvedValue(makeRouteResponse(50000, 3600));
    rerender({ positions: [TEL_AVIV_MOVED, JERUSALEM_MOVED] });

    await act(async () => {
      vi.advanceTimersByTime(6000); // doubled backoff
    });

    // Third call: should be back to 3s debounce
    mockFetch.mockClear();
    rerender({ positions: [HAIFA, JERUSALEM] });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  it("cleans up abort controller and timer on unmount", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");

    const { unmount } = renderHook(() =>
      useDirections([TEL_AVIV, JERUSALEM], MIDPOINT),
    );

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    abortSpy.mockRestore();
  });
});

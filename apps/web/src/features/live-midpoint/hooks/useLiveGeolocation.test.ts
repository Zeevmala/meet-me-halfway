import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveGeolocation } from "./useLiveGeolocation";

// ── Geolocation mock ──
let watchCallback: PositionCallback | null = null;
let watchErrorCallback: PositionErrorCallback | null = null;
const mockClearWatch = vi.fn();
let watchIdCounter = 0;

function createMockGeolocation() {
  return {
    watchPosition: vi.fn(
      (success: PositionCallback, error?: PositionErrorCallback | null) => {
        watchCallback = success;
        watchErrorCallback = error ?? null;
        return ++watchIdCounter;
      },
    ),
    clearWatch: mockClearWatch,
    getCurrentPosition: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  watchCallback = null;
  watchErrorCallback = null;
  watchIdCounter = 0;
  vi.stubGlobal("navigator", { geolocation: createMockGeolocation() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLiveGeolocation", () => {
  it("starts in idle state", () => {
    const { result } = renderHook(() => useLiveGeolocation());

    expect(result.current.status).toBe("idle");
    expect(result.current.position).toBeNull();
    expect(result.current.accuracy).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("transitions to requesting on start()", () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    expect(result.current.status).toBe("requesting");
    expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
  });

  it("transitions to watching on success with position data", () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    act(() => {
      watchCallback?.({
        coords: {
          latitude: 32.08,
          longitude: 34.78,
          accuracy: 10,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });

    expect(result.current.status).toBe("watching");
    expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
    expect(result.current.accuracy).toBe(10);
    expect(result.current.error).toBeNull();
  });

  it('sets status to "denied" on PERMISSION_DENIED error', () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    act(() => {
      const err = {
        code: 1,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        message: "User denied",
      } as GeolocationPositionError;
      watchErrorCallback?.(err);
    });

    expect(result.current.status).toBe("denied");
    expect(result.current.error).toBe("Location access denied.");
  });

  it('sets status to "unavailable" on POSITION_UNAVAILABLE error', () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    act(() => {
      const err = {
        code: 2,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        message: "Position unavailable",
      } as GeolocationPositionError;
      watchErrorCallback?.(err);
    });

    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe("Location not available.");
  });

  it('sets status to "error" on TIMEOUT', () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    act(() => {
      const err = {
        code: 3,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        message: "Timeout",
      } as GeolocationPositionError;
      watchErrorCallback?.(err);
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Location request timed out.");
  });

  it("calls clearWatch on stop()", () => {
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    act(() => {
      result.current.stop();
    });

    expect(mockClearWatch).toHaveBeenCalledWith(1);
    expect(result.current.status).toBe("idle");
  });

  it("calls clearWatch on unmount", () => {
    const { result, unmount } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    unmount();

    expect(mockClearWatch).toHaveBeenCalled();
  });

  it("sets unavailable when navigator.geolocation is missing", () => {
    vi.stubGlobal("navigator", {});

    const { result } = renderHook(() => useLiveGeolocation());

    act(() => {
      result.current.start();
    });

    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe(
      "Geolocation is not supported by this browser.",
    );
  });
});

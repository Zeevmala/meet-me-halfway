import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveGeolocation } from "./useLiveGeolocation";

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));
vi.mock("@sentry/react", () => ({ captureMessage: mockCaptureMessage }));

// ── Geolocation mock ──
let watchCallback: PositionCallback | null = null;
let watchErrorCallback: PositionErrorCallback | null = null;
// Watches that have been started and not cleared — the property that matters,
// since a cleared watch delivers nothing no matter what status says.
const liveWatches = new Set<number>();
const mockClearWatch = vi.fn((id: number) => liveWatches.delete(id));
let watchIdCounter = 0;

function createMockGeolocation() {
  return {
    watchPosition: vi.fn(
      (success: PositionCallback, error?: PositionErrorCallback | null) => {
        watchCallback = success;
        watchErrorCallback = error ?? null;
        liveWatches.add(++watchIdCounter);
        return watchIdCounter;
      },
    ),
    clearWatch: mockClearWatch,
    getCurrentPosition: vi.fn(),
  };
}

function geoError(code: 1 | 2 | 3, message: string): GeolocationPositionError {
  return {
    code,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
    message,
  } as GeolocationPositionError;
}

function fix(lat: number, lng: number): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lng,
      accuracy: 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

beforeEach(() => {
  vi.clearAllMocks();
  watchCallback = null;
  watchErrorCallback = null;
  watchIdCounter = 0;
  liveWatches.clear();
  vi.stubGlobal("navigator", { geolocation: createMockGeolocation() });
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(result.current.error).toBe("PERMISSION_DENIED: User denied");
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
    // The code's name plus the browser's wording, for the details panel.
    expect(result.current.error).toBe(
      "POSITION_UNAVAILABLE: Position unavailable",
    );
  });

  it("names the error when the browser gives no message", () => {
    // What Chrome actually sends for POSITION_UNAVAILABLE.
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => watchErrorCallback?.(geoError(2, "")));

    expect(result.current.error).toBe("POSITION_UNAVAILABLE");
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
    expect(result.current.error).toBe("TIMEOUT: Timeout");
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
  describe("transient failures", () => {
    it("restarts the watch after POSITION_UNAVAILABLE and recovers on the next fix", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => watchErrorCallback?.(geoError(2, "provider failed")));
      expect(result.current.status).toBe("unavailable");

      // The screenshot: this used to be a screen with no way out.
      act(() => vi.advanceTimersByTime(2_000));
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);
      expect(mockClearWatch).toHaveBeenCalledWith(1);
      expect([...liveWatches]).toEqual([2]);

      act(() => watchCallback?.(fix(32.08, 34.78)));
      expect(result.current.status).toBe("watching");
      expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
      expect(result.current.error).toBeNull();
    });

    it("restarts after TIMEOUT too", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => watchErrorCallback?.(geoError(3, "Timeout expired")));
      act(() => vi.advanceTimersByTime(2_000));

      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);
      expect(liveWatches.size).toBe(1);
    });

    it("keeps the last fix and status once a position has been seen", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => watchCallback?.(fix(32.08, 34.78)));

      act(() => watchErrorCallback?.(geoError(2, "provider failed")));

      // A blip mid-session must not swap the map for an error screen.
      expect(result.current.status).toBe("watching");
      expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
      act(() => vi.advanceTimersByTime(2_000));
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);
    });

    it("schedules one restart however many errors arrive", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => {
        watchErrorCallback?.(geoError(2, "a"));
        watchErrorCallback?.(geoError(2, "b"));
        watchErrorCallback?.(geoError(3, "c"));
      });
      act(() => vi.advanceTimersByTime(2_000));

      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);
    });

    it("backs off between consecutive failures", () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.999);
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => watchErrorCallback?.(geoError(2, "x")));
      act(() => vi.advanceTimersByTime(2_000));
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);

      // Second consecutive failure waits ~4s, not 2s.
      act(() => watchErrorCallback?.(geoError(2, "x")));
      act(() => vi.advanceTimersByTime(2_000));
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(2);
      act(() => vi.advanceTimersByTime(2_000));
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(3);
    });

    it("does not retry after PERMISSION_DENIED", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => watchErrorCallback?.(geoError(1, "User denied")));
      act(() => vi.advanceTimersByTime(60_000));

      expect(result.current.status).toBe("denied");
      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
      expect(liveWatches.size).toBe(0);
    });

    it("stop() cancels a pending restart", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => watchErrorCallback?.(geoError(2, "x")));

      act(() => result.current.stop());
      act(() => vi.advanceTimersByTime(60_000));

      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
      expect(liveWatches.size).toBe(0);
    });

    it("unmount cancels a pending restart", () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => watchErrorCallback?.(geoError(2, "x")));

      unmount();
      act(() => vi.advanceTimersByTime(60_000));

      expect(navigator.geolocation.watchPosition).toHaveBeenCalledTimes(1);
      expect(liveWatches.size).toBe(0);
    });

    it("start → stop → start leaves exactly one live watch", () => {
      // The StrictMode dev cycle, which used to leave zero.
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => {
        result.current.start();
        result.current.stop();
        result.current.start();
      });

      expect(liveWatches.size).toBe(1);
      expect(result.current.status).toBe("requesting");
    });
  });

  describe("telemetry", () => {
    it("reports each error code once, with the permission state", async () => {
      vi.stubGlobal("navigator", {
        geolocation: createMockGeolocation(),
        permissions: {
          query: vi.fn().mockResolvedValue({ state: "granted" }),
        },
      });
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => {
        watchErrorCallback?.(geoError(2, "provider failed"));
        watchErrorCallback?.(geoError(2, "provider failed"));
      });

      await vi.waitFor(() =>
        expect(mockCaptureMessage).toHaveBeenCalledTimes(1),
      );
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "geolocation_error",
        expect.objectContaining({
          tags: expect.objectContaining({
            geo_code: "2",
            geo_permission: "granted",
            geo_had_fix: "false",
          }),
          extra: { message: "provider failed" },
        }),
      );
    });

    it("still reports when the Permissions API is missing", async () => {
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => watchErrorCallback?.(geoError(3, "Timeout")));

      await vi.waitFor(() =>
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "geolocation_error",
          expect.objectContaining({
            tags: expect.objectContaining({ geo_permission: "unknown" }),
          }),
        ),
      );
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveGeolocation } from "./useLiveGeolocation";

const { mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureMessage: vi.fn(),
}));
vi.mock("@sentry/react", () => ({ captureMessage: mockCaptureMessage }));

// ── Geolocation mock ──
// Callbacks are kept per watch, and only live watches can deliver — as in a
// browser, where a cleared watch never calls back. A single global callback,
// overwritten by every watchPosition, always delivered to the newest watch,
// which hid both a fix lost to a needless restart and a restart that tore
// down a watch that had already recovered.
interface MockWatch {
  success: PositionCallback;
  error: PositionErrorCallback | null;
}
const watches = new Map<number, MockWatch>();
const mockClearWatch = vi.fn((id: number) => {
  watches.delete(id);
});
let nextWatchId = 0;

function createMockGeolocation() {
  return {
    watchPosition: vi.fn(
      (success: PositionCallback, error?: PositionErrorCallback | null) => {
        const id = ++nextWatchId;
        watches.set(id, { success, error: error ?? null });
        return id;
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

/** The most recently started watch that is still live. */
function newestWatch(): number {
  return [...watches.keys()].pop() ?? -1;
}

/** Deliver a fix to one watch (default: the newest live one). */
function sendFix(lat: number, lng: number, id = newestWatch()) {
  watches.get(id)?.success(fix(lat, lng));
}

/** Deliver an error to one watch (default: the newest live one). */
function sendError(code: 1 | 2 | 3, message: string, id = newestWatch()) {
  watches.get(id)?.error?.(geoError(code, message));
}

const watchPositionCalls = () =>
  vi.mocked(navigator.geolocation.watchPosition).mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  watches.clear();
  nextWatchId = 0;
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

    act(() => result.current.start());

    expect(result.current.status).toBe("requesting");
    expect(watchPositionCalls()).toBe(1);
  });

  it("transitions to watching on success with position data", () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => sendFix(32.08, 34.78));

    expect(result.current.status).toBe("watching");
    expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
    expect(result.current.accuracy).toBe(10);
    expect(result.current.error).toBeNull();
  });

  it('sets status to "denied" on PERMISSION_DENIED error', () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => sendError(1, "User denied Geolocation"));

    expect(result.current.status).toBe("denied");
    expect(result.current.error).toBe(
      "PERMISSION_DENIED: User denied Geolocation",
    );
  });

  // Unlike a GPS blip, a denial means the user stopped sharing. The last fix
  // used to stand, and presence kept re-publishing it to the session as live.
  it("takes back the last position when permission is revoked mid-session", () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());
    act(() => sendFix(32.08, 34.78));

    act(() => sendError(1, "User denied Geolocation"));

    expect(result.current.status).toBe("denied");
    expect(result.current.position).toBeNull();
    expect(result.current.accuracy).toBeNull();
  });

  it('sets status to "unavailable" on POSITION_UNAVAILABLE error', () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => sendError(2, "Failed to request location updates: x"));

    expect(result.current.status).toBe("unavailable");
    // The code's name plus the browser's wording, for the details panel.
    expect(result.current.error).toBe(
      "POSITION_UNAVAILABLE: Failed to request location updates: x",
    );
  });

  it("names the error when the browser gives no message", () => {
    // DevTools' emulated outage, for one, sends an empty message.
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => sendError(2, ""));

    expect(result.current.error).toBe("POSITION_UNAVAILABLE");
  });

  it('sets status to "error" on TIMEOUT', () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => sendError(3, "Timeout expired"));

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("TIMEOUT: Timeout expired");
  });

  it("calls clearWatch on stop()", () => {
    const { result } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    act(() => result.current.stop());

    expect(mockClearWatch).toHaveBeenCalledWith(1);
    expect(result.current.status).toBe("idle");
  });

  it("calls clearWatch on unmount", () => {
    const { result, unmount } = renderHook(() => useLiveGeolocation());
    act(() => result.current.start());

    unmount();

    expect(mockClearWatch).toHaveBeenCalled();
  });

  it("sets unavailable when navigator.geolocation is missing", () => {
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useLiveGeolocation());

    act(() => result.current.start());

    expect(result.current.status).toBe("unavailable");
    expect(result.current.error).toBe(
      "Geolocation is not supported by this browser.",
    );
  });

  describe("recovery", () => {
    it("restarts the watch after POSITION_UNAVAILABLE and recovers on the next fix", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(2, "Failed to request location updates: x"));
      expect(result.current.status).toBe("unavailable");

      // The screenshot: this used to be a screen with no way out. Chrome never
      // re-issues a failed platform request while the watch lives, so only a
      // new watch can.
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);
      expect([...watches.keys()]).toEqual([2]);

      act(() => sendFix(32.08, 34.78));
      expect(result.current.status).toBe("watching");
      expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
      expect(result.current.error).toBeNull();
    });

    it("leaves a timed-out watch alive, and takes its late fix", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(3, "Timeout expired"));
      act(() => vi.advanceTimersByTime(10_000));

      // Restarting here would throw away an acquisition still in progress.
      expect(watchPositionCalls()).toBe(1);
      act(() => sendFix(32.08, 34.78, 1));
      expect(result.current.status).toBe("watching");
    });

    it("a fix cancels a pending restart", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(2, "blip"));
      act(() => vi.advanceTimersByTime(500));
      act(() => sendFix(32.08, 34.78, 1));
      act(() => vi.advanceTimersByTime(60_000));

      // The recovered watch is kept, not torn down by the stale restart.
      expect(watchPositionCalls()).toBe(1);
      expect([...watches.keys()]).toEqual([1]);
      expect(result.current.status).toBe("watching");
    });

    it("does not loop when each new watch is first handed a cached error", () => {
      // Chrome replays the provider's last error to a new subscriber before
      // any fresh result. Model a healthy provider doing exactly that: every
      // watch gets the stale code 2 at once, then real fixes from 500ms on.
      vi.useFakeTimers();
      vi.mocked(navigator.geolocation.watchPosition).mockImplementation(
        (success, error) => {
          const id = ++nextWatchId;
          watches.set(id, { success, error: error ?? null });
          setTimeout(() => sendError(2, "stale", id), 0);
          setTimeout(() => sendFix(32.08, 34.78, id), 500);
          return id;
        },
      );
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => vi.advanceTimersByTime(120_000));

      expect(watchPositionCalls()).toBe(1);
      expect(result.current.status).toBe("watching");
    });

    it("a restarted watch is not torn down by the replay of its cause", () => {
      // The provider recovered, but this fresh request needs 35s to a fix —
      // longer than any backoff delay. Restarting on the replayed error would
      // kill each replacement before it could answer.
      vi.useFakeTimers();
      vi.mocked(navigator.geolocation.watchPosition).mockImplementation(
        (success, error) => {
          const id = ++nextWatchId;
          watches.set(id, { success, error: error ?? null });
          if (id > 1) {
            setTimeout(() => sendError(2, "Failed to request", id), 0);
            setTimeout(() => sendFix(32.08, 34.78, id), 35_000);
          }
          return id;
        },
      );
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "Failed to request", 1));

      act(() => vi.advanceTimersByTime(60_000));

      expect(watchPositionCalls()).toBe(2);
      expect(result.current.status).toBe("watching");
    });

    it("a restarted watch whose fresh request fails again is restarted", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "Failed to request"));
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);

      // Replay first, then the fresh request's own failure.
      act(() => {
        sendError(2, "Failed to request");
        sendError(2, "Failed to request");
      });
      act(() => vi.advanceTimersByTime(4_000));

      expect(watchPositionCalls()).toBe(3);
      expect(result.current.status).toBe("unavailable");
    });

    it("without a replay, a restarted watch's real failure is retried on the long fuse", () => {
      // Older Chromium and WebKit do not replay, so a restarted watch's
      // opening code 2 is the fresh request failing. It must not end retrying.
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "Failed to request"));
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);

      act(() => sendError(2, "Failed to request"));
      act(() => vi.advanceTimersByTime(59_000));
      expect(watchPositionCalls()).toBe(2);
      act(() => vi.advanceTimersByTime(1_000));
      expect(watchPositionCalls()).toBe(3);
      expect(result.current.status).toBe("unavailable");
    });

    it("without a replay, recovers once a mid-session outage clears", () => {
      // No-replay provider: every request fails for the first 20s, then
      // answers 3s after it is made. The position has moved meanwhile.
      vi.useFakeTimers();
      const t0 = Date.now();
      vi.mocked(navigator.geolocation.watchPosition).mockImplementation(
        (success, error) => {
          const id = ++nextWatchId;
          watches.set(id, { success, error: error ?? null });
          if (Date.now() - t0 < 20_000) {
            setTimeout(() => sendError(2, "Failed to request", id), 100);
          } else {
            setTimeout(() => sendFix(40, 35, id), 3_000);
          }
          return id;
        },
      );
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => vi.advanceTimersByTime(50));
      act(() => sendFix(32.08, 34.78, 1));

      act(() => vi.advanceTimersByTime(150_000));

      expect(result.current.status).toBe("watching");
      expect(result.current.position).toEqual({ lat: 40, lng: 35 });
    });

    // Chrome 150+ provider: a failed request stays failed for the watch's
    // life; every new watch is first handed the cached error, and its fresh
    // request then answers after `latency`.
    function chrome150(latency: number, firstWatch: (id: number) => void) {
      vi.mocked(navigator.geolocation.watchPosition).mockImplementation(
        (success, error) => {
          const id = ++nextWatchId;
          watches.set(id, { success, error: error ?? null });
          if (id === 1) {
            firstWatch(id);
          } else {
            setTimeout(() => sendError(2, "Failed to request", id), 0);
            setTimeout(() => sendFix(40, 35, id), latency);
          }
          return id;
        },
      );
    }

    it.each([70_000, 150_000])(
      "on Chrome 150+, a fresh request needing %ims after one failure still gets its fix",
      (latency) => {
        // A fuse that never grew tore each such request down at 60s, forever.
        vi.useFakeTimers();
        chrome150(latency, (id) =>
          setTimeout(() => sendError(2, "Failed to request", id), 0),
        );
        const { result } = renderHook(() => useLiveGeolocation());
        act(() => result.current.start());

        act(() => vi.advanceTimersByTime(600_000));

        expect(result.current.status).toBe("watching");
        expect(result.current.position).toEqual({ lat: 40, lng: 35 });
      },
    );

    it("on Chrome 150+, a slow re-acquisition after a mid-session failure lands", () => {
      vi.useFakeTimers();
      chrome150(70_000, (id) => {
        setTimeout(() => sendFix(32.08, 34.78, id), 1_000);
        setTimeout(() => sendError(2, "Failed to request", id), 60_000);
      });
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => vi.advanceTimersByTime(600_000));

      expect(result.current.position).toEqual({ lat: 40, lng: 35 });
    });

    it("Try again after a mid-session denial still reports what fails next", () => {
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendFix(32.08, 34.78));
      act(() => sendError(1, "User denied Geolocation"));
      expect(result.current.status).toBe("denied");

      act(() => result.current.start());
      act(() => sendError(3, "Timeout expired"));

      // Not stuck on "requesting" over the pre-denial position.
      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("TIMEOUT: Timeout expired");
    });

    it("keeps the last fix and status once a position has been seen", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendFix(32.08, 34.78));

      act(() => sendError(2, "provider failed"));

      // A blip mid-session must not swap the map for an error screen.
      expect(result.current.status).toBe("watching");
      expect(result.current.position).toEqual({ lat: 32.08, lng: 34.78 });
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);
    });

    it("a TIMEOUT does not replace an earlier POSITION_UNAVAILABLE", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(2, "Failed to request location updates: x"));
      act(() => vi.advanceTimersByTime(2_000));
      act(() => sendError(3, "Timeout expired"));

      // One screen, still naming the failure that matters.
      expect(result.current.status).toBe("unavailable");
      expect(result.current.error).toBe(
        "POSITION_UNAVAILABLE: Failed to request location updates: x",
      );
    });

    it("Try again starts clean, so a later TIMEOUT is reported as one", () => {
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "x"));

      act(() => result.current.start());
      act(() => sendError(3, "Timeout expired"));

      expect(result.current.status).toBe("error");
    });

    it("schedules one restart however many errors arrive", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => {
        sendError(2, "a");
        sendError(2, "b");
        sendError(3, "c");
      });
      act(() => vi.advanceTimersByTime(2_000));

      expect(watchPositionCalls()).toBe(2);
    });

    it("backs off between consecutive failures", () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0.999);
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(2, "x"));
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);

      // Second consecutive failure waits ~4s, not 2s. A restarted watch first
      // gets the replay of the error that restarted it, then its own.
      act(() => {
        sendError(2, "x");
        sendError(2, "x");
      });
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(2);
      act(() => vi.advanceTimersByTime(2_000));
      expect(watchPositionCalls()).toBe(3);
    });

    it("does not retry after PERMISSION_DENIED", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(1, "User denied Geolocation"));
      act(() => vi.advanceTimersByTime(60_000));

      // Only a tap can recover this (the page's Try again button).
      expect(result.current.status).toBe("denied");
      expect(watchPositionCalls()).toBe(1);
      expect(watches.size).toBe(0);
    });

    it("stop() cancels a pending restart", () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "x"));

      act(() => result.current.stop());
      act(() => vi.advanceTimersByTime(60_000));

      expect(watchPositionCalls()).toBe(1);
      expect(watches.size).toBe(0);
    });

    it("unmount cancels a pending restart", () => {
      vi.useFakeTimers();
      const { result, unmount } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());
      act(() => sendError(2, "x"));

      unmount();
      act(() => vi.advanceTimersByTime(60_000));

      expect(watchPositionCalls()).toBe(1);
      expect(watches.size).toBe(0);
    });

    it("start → stop → start leaves exactly one live watch", () => {
      // The StrictMode dev cycle, which used to leave zero.
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => {
        result.current.start();
        result.current.stop();
        result.current.start();
      });

      expect(watches.size).toBe(1);
      expect(result.current.status).toBe("requesting");
    });
  });

  describe("telemetry", () => {
    it("reports each error code once, with the permission state and message", async () => {
      vi.stubGlobal("navigator", {
        geolocation: createMockGeolocation(),
        permissions: {
          query: vi.fn().mockResolvedValue({ state: "granted" }),
        },
      });
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => {
        sendError(2, "Failed to request location updates: x");
        sendError(2, "Failed to request location updates: x");
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
            geo_msg: "Failed to request location updates: x",
          }),
          extra: { message: "Failed to request location updates: x" },
        }),
      );
    });

    it("still reports when the Permissions API is missing or the message empty", async () => {
      const { result } = renderHook(() => useLiveGeolocation());
      act(() => result.current.start());

      act(() => sendError(3, ""));

      await vi.waitFor(() =>
        expect(mockCaptureMessage).toHaveBeenCalledWith(
          "geolocation_error",
          expect.objectContaining({
            tags: expect.objectContaining({
              geo_permission: "unknown",
              geo_msg: "(empty)",
            }),
          }),
        ),
      );
    });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNetworkStatus } from "./useNetworkStatus";

// ── Mock firebase/database ──
let onValueCallback: ((snap: { val: () => unknown }) => void) | null = null;
const mockOnValueUnsub = vi.fn();

vi.mock("firebase/database", () => ({
  onValue: (_ref: unknown, onSnap: (snap: { val: () => unknown }) => void) => {
    onValueCallback = onSnap;
    return mockOnValueUnsub;
  },
  ref: (_db: unknown, path?: string) => ({ path }),
}));

// ── Mock useFirebase ──
const mockDb = { _db: true };
vi.mock("./useFirebase", () => ({
  useFirebase: () => ({ app: {}, db: mockDb }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  onValueCallback = null;
  vi.stubGlobal("navigator", { onLine: true });
});

describe("useNetworkStatus", () => {
  it("returns online when navigator.onLine is true", () => {
    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.browserOnline).toBe(true);
    expect(result.current.isOnline).toBe(true);
  });

  it("returns offline when navigator.onLine is false", () => {
    vi.stubGlobal("navigator", { onLine: false });

    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.browserOnline).toBe(false);
    expect(result.current.isOnline).toBe(false);
  });

  it("transitions to offline when offline event fires", () => {
    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.browserOnline).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current.browserOnline).toBe(false);
    expect(result.current.isOnline).toBe(false);
  });

  it("transitions to online when online event fires", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result } = renderHook(() => useNetworkStatus());

    expect(result.current.browserOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(result.current.browserOnline).toBe(true);
  });

  it("flips firebaseConnected immediately but keeps isOnline true during 6s grace period", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useNetworkStatus());

      act(() => {
        onValueCallback?.({ val: () => false });
      });

      // Raw signal flips immediately; debounced isOnline stays true.
      expect(result.current.firebaseConnected).toBe(false);
      expect(result.current.isOnline).toBe(true);

      // Just before grace period — still considered online.
      act(() => {
        vi.advanceTimersByTime(5_999);
      });
      expect(result.current.isOnline).toBe(true);

      // Once grace period elapses — banner-worthy offline.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.isOnline).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the offline grace timer if Firebase reconnects before it fires", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useNetworkStatus());

      act(() => {
        onValueCallback?.({ val: () => false });
      });
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      // Reconnect within the grace window.
      act(() => {
        onValueCallback?.({ val: () => true });
      });
      // Advance past where the timer would have fired.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(result.current.firebaseConnected).toBe(true);
      expect(result.current.isOnline).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up event listeners and Firebase subscription on unmount", () => {
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useNetworkStatus());

    unmount();

    expect(removeListenerSpy).toHaveBeenCalledWith(
      "online",
      expect.any(Function),
    );
    expect(removeListenerSpy).toHaveBeenCalledWith(
      "offline",
      expect.any(Function),
    );
    expect(mockOnValueUnsub).toHaveBeenCalled();

    removeListenerSpy.mockRestore();
  });
});

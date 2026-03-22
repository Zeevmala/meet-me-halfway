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

  it("sets firebaseConnected to false when .info/connected is false", () => {
    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      onValueCallback?.({ val: () => false });
    });

    expect(result.current.firebaseConnected).toBe(false);
    expect(result.current.isOnline).toBe(false);
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

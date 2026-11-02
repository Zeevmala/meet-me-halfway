import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import { useNetworkStatus } from "./useNetworkStatus";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));

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
// `appCheckReady` is read inside the accessor rather than captured when the
// mock is built, so a case can swap in a promise it settles by hand.
const mockDb = { _db: true };
let appCheckReady: Promise<unknown>;
vi.mock("./useFirebase", () => ({
  useFirebase: () => ({ app: {}, db: mockDb, appCheckReady }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  onValueCallback = null;
  appCheckReady = Promise.resolve({ ok: true, reason: "token", latencyMs: 12 });
  vi.stubGlobal("navigator", { onLine: true });
});

/**
 * Render, then let attestation settle.
 *
 * The `.info/connected` listener hangs off a `.then` on `appCheckReady` now,
 * so it attaches one microtask behind the render. Every case that drives the
 * listener has to flush first — which is itself the point of the change.
 */
async function mount() {
  const rendered = renderHook(() => useNetworkStatus());
  await act(async () => {});
  return rendered;
}

/** A promise this test settles by hand, to hold attestation open. */
function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("useNetworkStatus", () => {
  it("returns online when navigator.onLine is true", async () => {
    const { result } = await mount();

    expect(result.current.browserOnline).toBe(true);
    expect(result.current.connectivity).toBe("online");
  });

  it("returns offline when navigator.onLine is false", async () => {
    vi.stubGlobal("navigator", { onLine: false });

    const { result } = await mount();

    expect(result.current.browserOnline).toBe(false);
    expect(result.current.connectivity).toBe("offline");
  });

  it("transitions to offline when offline event fires", async () => {
    const { result } = await mount();

    expect(result.current.browserOnline).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current.browserOnline).toBe(false);
    expect(result.current.connectivity).toBe("offline");
  });

  it("transitions to online when online event fires", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { result } = await mount();

    expect(result.current.browserOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(result.current.browserOnline).toBe(true);
    expect(result.current.connectivity).toBe("online");
  });

  // "You are offline" was the only thing this could say, so a phone with a
  // working network — map tiles loading under the banner — was told it had
  // none when it was the database it could not reach.
  it("calls a database it cannot reach for the grace period unreachable, not offline", async () => {
    vi.useFakeTimers();
    try {
      const { result } = await mount();

      act(() => {
        onValueCallback?.({ val: () => false });
      });

      // Raw signal flips immediately; the debounced verdict holds.
      expect(result.current.firebaseConnected).toBe(false);
      expect(result.current.connectivity).toBe("online");

      // Just before the grace period ends — still online.
      act(() => {
        vi.advanceTimersByTime(5_999);
      });
      expect(result.current.connectivity).toBe("online");

      // Once it elapses — banner-worthy, and the browser is still online.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.browserOnline).toBe(true);
      expect(result.current.connectivity).toBe("unreachable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the offline grace timer if Firebase reconnects before it fires", async () => {
    vi.useFakeTimers();
    try {
      const { result } = await mount();

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
      expect(result.current.connectivity).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says offline when the browser has no network, whatever the database says", async () => {
    vi.useFakeTimers();
    try {
      const { result } = await mount();

      act(() => {
        onValueCallback?.({ val: () => false });
        vi.advanceTimersByTime(6_000);
      });
      expect(result.current.connectivity).toBe("unreachable");

      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(result.current.connectivity).toBe("offline");
    } finally {
      vi.useRealTimers();
    }
  });

  // Every read and write waits in this state and none fails, so nothing else
  // would ever report it.
  it("reports an unreachable database once per page", async () => {
    vi.useFakeTimers();
    try {
      const { result } = await mount();
      const dropFor = (ms: number) => {
        act(() => {
          onValueCallback?.({ val: () => false });
          vi.advanceTimersByTime(ms);
        });
      };

      dropFor(5_999);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();

      dropFor(1);
      expect(result.current.connectivity).toBe("unreachable");
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith("rtdb_unreachable", {
        level: "warning",
      });

      act(() => {
        onValueCallback?.({ val: () => true });
      });
      dropFor(6_000);
      expect(result.current.connectivity).toBe("unreachable");
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up event listeners and Firebase subscription on unmount", async () => {
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = await mount();

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

  /**
   * `.info/connected` is answered from the SDK's local tree, so this listener
   * opens no socket — the session handshake's first read or write does, and it
   * awaits attestation itself. The listener waits too so that the grace period
   * times the connection attempt: attached at once, `.info/connected` reads
   * false immediately and a slow reCAPTCHA would be counted against a socket
   * nobody had tried to open yet.
   */
  describe("attestation gate", () => {
    it("does not start watching the connection before attestation settles", async () => {
      const gate = deferred();
      appCheckReady = gate.promise;

      renderHook(() => useNetworkStatus());
      await act(async () => {});

      expect(onValueCallback).toBeNull();

      await act(async () => {
        gate.settle();
      });

      expect(onValueCallback).not.toBeNull();
    });

    it("connects anyway when attestation times out", async () => {
      // Degrade, never block: a device that cannot reach reCAPTCHA still gets
      // a working app, it just shows up as unverified.
      appCheckReady = Promise.resolve({ ok: false, reason: "timeout" });

      await mount();

      expect(onValueCallback).not.toBeNull();
    });

    it("does not subscribe when unmounted while attestation is in flight", async () => {
      // Cleanup has already run by the time the promise settles, so without
      // the cancelled guard this would attach a listener nothing can detach.
      const gate = deferred();
      appCheckReady = gate.promise;

      const { unmount } = renderHook(() => useNetworkStatus());
      unmount();

      await act(async () => {
        gate.settle();
      });

      expect(onValueCallback).toBeNull();
      expect(mockOnValueUnsub).not.toHaveBeenCalled();
    });
  });
});

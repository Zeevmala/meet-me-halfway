import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAuth } from "./useAuth";

// ── Mock firebase/auth ──
const mockSignInAnonymously = vi.fn();
let authStateCallback: ((user: { uid: string } | null) => void) | null = null;
let authErrorCallback: ((err: Error) => void) | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("firebase/auth", () => ({
  signInAnonymously: (...args: unknown[]) => mockSignInAnonymously(...args),
  onAuthStateChanged: (
    _auth: unknown,
    onUser: (user: { uid: string } | null) => void,
    onError: (err: Error) => void,
  ) => {
    authStateCallback = onUser;
    authErrorCallback = onError;
    return mockUnsubscribe;
  },
}));

// ── Mock useFirebase ──
// Stable singleton — the real useFirebase memoizes its return value, and
// useAuth's effect depends on `auth` identity. A fresh object per render
// would re-run the effect in a loop.
const stableFirebase = { app: {}, db: {}, auth: {}, appCheck: null };
vi.mock("./useFirebase", () => ({
  useFirebase: () => stableFirebase,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authStateCallback = null;
  authErrorCallback = null;
  mockSignInAnonymously.mockResolvedValue({});
});

describe("useAuth", () => {
  it("starts in loading state", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.status).toBe("loading");
  });

  it("transitions to authenticated when onAuthStateChanged fires with a user", async () => {
    const { result } = renderHook(() => useAuth());

    // Simulate Firebase returning an authenticated user
    authStateCallback?.({ uid: "test-uid-abc123" });

    await waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });

    if (result.current.status === "authenticated") {
      expect(result.current.uid).toBe("test-uid-abc123");
    }
  });

  it("calls signInAnonymously on mount", () => {
    renderHook(() => useAuth());
    expect(mockSignInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("transitions to error after all retries are exhausted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSignInAnonymously.mockRejectedValue(new Error("Auth disabled"));

    const { result } = renderHook(() => useAuth());

    // Flush all microtasks + timers for 3 retry attempts
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe("error");
    if (result.current.status === "error") {
      expect(result.current.code).toBe("AUTH_FAILED");
      expect(result.current.message).toBe("Auth disabled");
    }
    // Initial call + retries
    expect(mockSignInAnonymously.mock.calls.length).toBeGreaterThanOrEqual(3);

    vi.useRealTimers();
  });

  it("transitions to error when onAuthStateChanged error callback fires", async () => {
    const { result } = renderHook(() => useAuth());

    authErrorCallback?.(new Error("Network failure"));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    if (result.current.status === "error") {
      expect(result.current.code).toBe("AUTH_NETWORK");
      expect(result.current.message).toBe("Network failure");
    }
  });

  it("unsubscribes from onAuthStateChanged on unmount", () => {
    const { unmount } = renderHook(() => useAuth());
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("does not transition to authenticated if user is null", async () => {
    const { result } = renderHook(() => useAuth());

    // Fire with null — no user signed in yet
    authStateCallback?.(null);

    // Should still be loading (signInAnonymously hasn't returned a user yet)
    expect(result.current.status).toBe("loading");
  });

  it("classifies storage-blocked errors and does not retry", async () => {
    const err = Object.assign(
      new Error("Firebase: Error (auth/web-storage-unsupported)."),
      { code: "auth/web-storage-unsupported" },
    );
    mockSignInAnonymously.mockRejectedValue(err);

    const { result } = renderHook(() => useAuth());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    if (result.current.status === "error") {
      expect(result.current.code).toBe("AUTH_STORAGE_BLOCKED");
      expect(result.current.message).toContain("auth/web-storage-unsupported");
    }
    // Terminal failure — no retries scheduled
    expect(mockSignInAnonymously).toHaveBeenCalledTimes(1);
  });

  it("retries network errors before surfacing AUTH_NETWORK", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const err = Object.assign(
      new Error("Firebase: Error (auth/network-request-failed)."),
      { code: "auth/network-request-failed" },
    );
    mockSignInAnonymously.mockRejectedValue(err);

    const { result } = renderHook(() => useAuth());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe("error");
    if (result.current.status === "error") {
      expect(result.current.code).toBe("AUTH_NETWORK");
    }
    expect(mockSignInAnonymously.mock.calls.length).toBeGreaterThanOrEqual(3);

    vi.useRealTimers();
  });
});

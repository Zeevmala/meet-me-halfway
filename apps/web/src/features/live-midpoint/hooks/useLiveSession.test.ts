import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveSession } from "./useLiveSession";

// ── Mock firebase/database ──
const mockSet = vi.fn();
const mockGet = vi.fn();
const mockRemove = vi.fn();
const mockRef = vi.fn((_db: unknown, path?: string) => ({ path }));
let onValueCallback: ((snap: { val: () => unknown }) => void) | null = null;
let onValueErrorCallback: ((err: Error) => void) | null = null;
const mockOnValueUnsub = vi.fn();

vi.mock("firebase/database", () => ({
  onValue: (
    _ref: unknown,
    onSnap: (snap: { val: () => unknown }) => void,
    onErr: (err: Error) => void,
  ) => {
    onValueCallback = onSnap;
    onValueErrorCallback = onErr;
    return mockOnValueUnsub;
  },
  ref: (_db: unknown, path?: string) => mockRef(_db, path),
  remove: (r: unknown) => mockRemove(r),
  set: (r: unknown, v: unknown) => mockSet(r, v),
  get: (r: unknown) => mockGet(r),
}));

// ── Mock useFirebase ──
const mockDb = { _db: true };
vi.mock("../../../hooks/useFirebase", () => ({
  useFirebase: () => ({ app: {}, db: mockDb }),
}));

// ── Mock session-code to return deterministic codes ──
vi.mock("../lib/session-code", () => ({
  generateCode: () => "ABC234",
}));

const TEST_UID = "user-abc-123";
const PARTNER_UID = "user-xyz-789";

beforeEach(() => {
  vi.clearAllMocks();
  onValueCallback = null;
  onValueErrorCallback = null;
  mockSet.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);

  // Mock window.location and history
  vi.stubGlobal("location", { href: "http://localhost:5173/", search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
});

describe("useLiveSession", () => {
  it("starts in idle phase with no code or role", () => {
    const { result } = renderHook(() => useLiveSession(TEST_UID));

    expect(result.current.phase).toBe("idle");
    expect(result.current.code).toBeNull();
    expect(result.current.role).toBeNull();
    expect(result.current.ownPosition).toBeNull();
    expect(result.current.partnerPosition).toBeNull();
    expect(result.current.error).toBeNull();
  });

  describe("createSession", () => {
    it("writes created timestamp and creatorUid to RTDB", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // Should have written `sessions/ABC234/created` and `sessions/ABC234/creatorUid`
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/ABC234/created" }),
        expect.any(Number),
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/ABC234/creatorUid" }),
        TEST_UID,
      );
    });

    it("sets role to 'a' and phase to 'waiting'", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      expect(result.current.role).toBe("a");
      expect(result.current.phase).toBe("waiting");
      expect(result.current.code).toBe("ABC234");
    });

    it("returns the generated session code", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      let code: string | undefined;
      await act(async () => {
        code = await result.current.createSession();
      });

      expect(code).toBe("ABC234");
    });

    it("updates URL with session code", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      expect(history.replaceState).toHaveBeenCalled();
    });

    it("starts listening for partner after create", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // The ref for participants should have been created
      expect(mockRef).toHaveBeenCalledWith(
        mockDb,
        "sessions/ABC234/participants",
      );
    });

    it("sets phase to error if RTDB write fails", async () => {
      mockSet.mockRejectedValue(new Error("Permission denied"));

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        try {
          await result.current.createSession();
        } catch {
          // Expected to throw
        }
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("CREATE_FAILED");
    });
  });

  describe("joinSession", () => {
    it("sets phase to error if session doesn't exist", async () => {
      mockGet.mockResolvedValue({ val: () => null });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("sets phase to error if session has no creatorUid", async () => {
      mockGet.mockResolvedValue({ val: () => ({ created: Date.now() }) });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("sets phase to error if joinerUid is already set", async () => {
      mockGet.mockResolvedValue({
        val: () => ({
          created: Date.now(),
          creatorUid: "creator-uid",
          joinerUid: "another-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("SESSION_FULL");
    });

    it("writes joinerUid and sets role to 'b' on successful join", async () => {
      mockGet.mockResolvedValue({
        val: () => ({
          created: Date.now(),
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/XYZ789/joinerUid" }),
        TEST_UID,
      );
      expect(result.current.role).toBe("b");
      expect(result.current.code).toBe("XYZ789");
    });

    it("sets phase to 'connected' if creator has participant data", async () => {
      const creatorUid = "creator-uid";
      mockGet.mockResolvedValue({
        val: () => ({
          created: Date.now(),
          creatorUid,
          participants: {
            [creatorUid]: {
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: Date.now(),
            },
          },
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("connected");
    });

    it("sets phase to error if session is expired (>24h)", async () => {
      const expiredTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
      mockGet.mockResolvedValue({
        val: () => ({
          created: expiredTime,
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("SESSION_EXPIRED");
    });

    it("joins successfully if session is less than 24h old", async () => {
      const recentTime = Date.now() - 23 * 60 * 60 * 1000; // 23 hours ago
      mockGet.mockResolvedValue({
        val: () => ({
          created: recentTime,
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("waiting");
      expect(result.current.role).toBe("b");
    });

    it("joins successfully if session has no created field (graceful)", async () => {
      mockGet.mockResolvedValue({
        val: () => ({
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("waiting");
      expect(result.current.role).toBe("b");
    });

    it("rejects session at exact 24h boundary", async () => {
      const exactBoundary = Date.now() - 24 * 60 * 60 * 1000 - 1; // just over 24h
      mockGet.mockResolvedValue({
        val: () => ({
          created: exactBoundary,
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("SESSION_EXPIRED");
    });

    it("sets phase to 'waiting' if creator has no participant data", async () => {
      mockGet.mockResolvedValue({
        val: () => ({
          created: Date.now(),
          creatorUid: "creator-uid",
        }),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789");
      });

      expect(result.current.phase).toBe("waiting");
    });
  });

  describe("listenForPartner", () => {
    it("sets partner position when partner data appears", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // Simulate partner writing their location
      act(() => {
        onValueCallback?.({
          val: () => ({
            [TEST_UID]: { lat: 32.08, lng: 34.78, accuracy: 10, ts: 1000 },
            [PARTNER_UID]: { lat: 31.76, lng: 35.21, accuracy: 15, ts: 2000 },
          }),
        });
      });

      expect(result.current.partnerPosition).toEqual({
        lat: 31.76,
        lng: 35.21,
      });
      expect(result.current.partnerAccuracy).toBe(15);
      expect(result.current.partnerLastSeen).toBe(2000);
      expect(result.current.phase).toBe("connected");
    });

    it("clears partner when participants is null", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // First connect
      act(() => {
        onValueCallback?.({
          val: () => ({
            [TEST_UID]: { lat: 32.08, lng: 34.78, accuracy: 10, ts: 1000 },
            [PARTNER_UID]: { lat: 31.76, lng: 35.21, accuracy: 15, ts: 2000 },
          }),
        });
      });

      expect(result.current.phase).toBe("connected");

      // Then partner leaves (only own data remains, but entire node could be null)
      act(() => {
        onValueCallback?.({ val: () => null });
      });

      expect(result.current.partnerPosition).toBeNull();
      expect(result.current.partnerAccuracy).toBeNull();
    });

    it("sets phase to error on connection error", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      act(() => {
        onValueErrorCallback?.(new Error("Permission denied"));
      });

      expect(result.current.phase).toBe("error");
      expect(result.current.error).toBe("CONNECTION_ERROR");
    });

    it("only own uid in participants means no partner found", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // Only own data present
      act(() => {
        onValueCallback?.({
          val: () => ({
            [TEST_UID]: { lat: 32.08, lng: 34.78, accuracy: 10, ts: 1000 },
          }),
        });
      });

      // Should not set partner position
      expect(result.current.partnerPosition).toBeNull();
      // Phase should remain waiting (set from createSession)
      expect(result.current.phase).toBe("waiting");
    });
  });

  describe("updateOwnLocation", () => {
    it("writes to participants/{uid} in RTDB", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      // Clear mocks to isolate updateOwnLocation calls
      mockSet.mockClear();
      mockRef.mockClear();

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      expect(mockRef).toHaveBeenCalledWith(
        mockDb,
        `sessions/ABC234/participants/${TEST_UID}`,
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lat: 32.08,
          lng: 34.78,
          accuracy: 10,
          ts: expect.any(Number),
        }),
      );
    });

    it("updates local ownPosition state", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      expect(result.current.ownPosition).toEqual({ lat: 32.08, lng: 34.78 });
    });

    it("does not write to RTDB if no session code", () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      mockSet.mockClear();
      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      // set should not be called for RTDB write (only local state update)
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe("RTDB write throttle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("writes to RTDB immediately on the first call (leading edge)", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      mockSet.mockClear();

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lat: 32.08, lng: 34.78, accuracy: 10 }),
      );
    });

    it("does not write a second call to RTDB within the 3s window", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      mockSet.mockClear();

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      expect(mockSet).toHaveBeenCalledTimes(1);
      mockSet.mockClear();

      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.updateOwnLocation({ lat: 32.09, lng: 34.79 }, 8);
      });

      expect(mockSet).not.toHaveBeenCalled();
    });

    it("updates local state immediately even when RTDB write is throttled", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.updateOwnLocation({ lat: 32.09, lng: 34.79 }, 8);
      });

      expect(result.current.ownPosition).toEqual({ lat: 32.09, lng: 34.79 });
    });

    it("flushes the most recent buffered position after 3s (trailing edge)", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      mockSet.mockClear();

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      mockSet.mockClear();

      // Buffer two more positions
      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.updateOwnLocation({ lat: 32.09, lng: 34.79 }, 8);
      });

      act(() => {
        vi.advanceTimersByTime(500);
        result.current.updateOwnLocation({ lat: 32.1, lng: 34.8 }, 5);
      });

      expect(mockSet).not.toHaveBeenCalled();

      // Advance past the 3s window from the first write
      act(() => {
        vi.advanceTimersByTime(1500);
      });

      // Should flush the LATEST position
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ lat: 32.1, lng: 34.8, accuracy: 5 }),
      );
    });

    it("cancels pending throttle timer on cleanup", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      act(() => {
        result.current.updateOwnLocation({ lat: 32.08, lng: 34.78 }, 10);
      });

      act(() => {
        vi.advanceTimersByTime(1000);
        result.current.updateOwnLocation({ lat: 32.09, lng: 34.79 }, 8);
      });

      mockSet.mockClear();

      act(() => {
        result.current.cleanup();
      });

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Only remove() should have been called, not a throttled set()
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe("stale detection", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks partner as stale after 30s of no updates", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      const connectTime = Date.now();
      act(() => {
        onValueCallback?.({
          val: () => ({
            [TEST_UID]: {
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: connectTime,
            },
            [PARTNER_UID]: {
              lat: 31.76,
              lng: 35.21,
              accuracy: 15,
              ts: connectTime,
            },
          }),
        });
      });

      expect(result.current.phase).toBe("connected");

      // Advance 40s (past 30s threshold + one 10s check interval)
      act(() => {
        vi.advanceTimersByTime(40_000);
      });

      expect(result.current.phase).toBe("partner_stale");
    });
  });

  describe("cleanup", () => {
    it("removes own participant data from RTDB", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      act(() => {
        result.current.cleanup();
      });

      expect(mockRemove).toHaveBeenCalledWith(
        expect.objectContaining({
          path: `sessions/ABC234/participants/${TEST_UID}`,
        }),
      );
    });

    it("unsubscribes from onValue listener", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession();
      });

      act(() => {
        result.current.cleanup();
      });

      expect(mockOnValueUnsub).toHaveBeenCalled();
    });

    it("does not call remove if no session code", () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      act(() => {
        result.current.cleanup();
      });

      expect(mockRemove).not.toHaveBeenCalled();
    });
  });
});

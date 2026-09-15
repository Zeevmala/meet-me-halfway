import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveSession } from "./useLiveSession";

// ── Mock firebase/database ──
const mockSet = vi.fn();
const mockGet = vi.fn();
const mockRemove = vi.fn();
const mockOnDisconnectRemove = vi.fn();
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
  onDisconnect: (r: unknown) => ({ remove: () => mockOnDisconnectRemove(r) }),
  set: (r: unknown, v: unknown) => mockSet(r, v),
  get: (r: unknown) => mockGet(r),
}));

// ── Mock firebase/app-check ──
const mockGetToken = vi.fn();
vi.mock("firebase/app-check", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// ── Mock useFirebase (appCheck is mutable so attestation tests can opt in) ──
const mockDb = { _db: true };
let mockAppCheck: object | null = null;
vi.mock("../../../hooks/useFirebase", () => ({
  useFirebase: () => ({ app: {}, db: mockDb, appCheck: mockAppCheck }),
}));

// ── Mock the injected services (the hook only reads the presence writer) ──
const mockPresenceRemove = vi.fn();
vi.mock("../../../components/ServicesProvider", () => ({
  useServices: () => ({
    presence: { write: vi.fn(), remove: mockPresenceRemove },
  }),
}));

/** Handshakes take a signal now, so an unmount can cancel the retry loop. */
const live = () => new AbortController().signal;

// ── Mock session-code to return deterministic codes ──
vi.mock("../lib/session-code", () => ({
  generateCode: () => "ABC234",
}));

/**
 * Resolve `get` per path.
 *
 * The slot claim reads `sessions/{code}/slots` directly, so a blanket
 * `mockResolvedValue` would hand it the whole session object and it would read
 * `created`/`creatorUid` as slot holders. `session` is the payload for the
 * session root; `slots` is what the claim sees.
 */
function mockSession(session: unknown, slots: Record<string, string> = {}) {
  mockGet.mockImplementation((r: { path?: string }) => {
    const path = r?.path ?? "";
    if (path.endsWith("/slots")) {
      return Promise.resolve({ val: () => slots });
    }
    // A single index. `claimSlot` re-reads the one it was refused to tell a
    // lost race from a structural denial, and RTDB answers null for an
    // unclaimed index — so the mock has to as well, or every refusal looks
    // like a lost race and the distinction under test disappears.
    const index = /\/slots\/(\d+)$/.exec(path);
    if (index) {
      return Promise.resolve({ val: () => slots[index[1]] ?? null });
    }
    return Promise.resolve({ val: () => session });
  });
}

const TEST_UID = "user-abc-123";
const PARTNER_UID = "user-xyz-789";
const PARTNER_UID_2 = "user-def-456";
const PARTNER_UID_3 = "user-ghi-012";
const PARTNER_UID_4 = "user-jkl-345";

beforeEach(() => {
  vi.clearAllMocks();
  onValueCallback = null;
  onValueErrorCallback = null;
  mockSet.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockOnDisconnectRemove.mockResolvedValue(undefined);
  mockPresenceRemove.mockReset();
  mockAppCheck = null;
  mockGetToken.mockResolvedValue({ token: "test-token" });

  // Mock window.location and history
  vi.stubGlobal("location", { href: "http://localhost:5173/", search: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
});

describe("useLiveSession", () => {
  it("starts idle with no code or index", () => {
    const { result } = renderHook(() => useLiveSession(TEST_UID));

    expect(result.current.status).toBe("idle");
    expect(result.current.code).toBeNull();
    expect(result.current.ownIndex).toBeNull();
    expect(result.current.participants).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  describe("createSession", () => {
    it("writes created, creatorUid, and claims slot 0", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/ABC234/created" }),
        expect.any(Number),
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/ABC234/creatorUid" }),
        TEST_UID,
      );
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "sessions/ABC234/slots/0",
        }),
        TEST_UID,
      );
    });

    it("sets ownIndex to 0 and phase to 'waiting'", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      expect(result.current.ownIndex).toBe(0);
      expect(result.current.status).toBe("ready");
      expect(result.current.code).toBe("ABC234");
    });

    it("returns the generated session code", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      let code: string | undefined;
      await act(async () => {
        code = await result.current.createSession(live());
      });

      expect(code).toEqual({ ok: true, value: "ABC234" });
    });

    it("updates URL with session code", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      expect(history.replaceState).toHaveBeenCalled();
    });

    it("starts listening for participants after create", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

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
          await result.current.createSession(live());
        } catch {
          // Expected to throw
        }
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("CREATE_FAILED");
    });

    // Regression: the participants listener must attach only AFTER `created`
    // is written. The .read rule requires `created > now - 24h`, so a
    // listener attached before the write is rejected with permission_denied.
    it("does not attach the participants listener when the create write fails", async () => {
      mockSet.mockRejectedValue(new Error("Permission denied"));

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        try {
          await result.current.createSession(live());
        } catch {
          // Expected to throw
        }
      });

      expect(mockRef).not.toHaveBeenCalledWith(
        mockDb,
        "sessions/ABC234/participants",
      );
    });
  });

  describe("joinSession", () => {
    // These two drive an empty snapshot, which the live rules never produce —
    // they deny the read first (see "session read is denied" below). They cover
    // the defensive branch, which is kept because it is what a future relaxed
    // `.read` would hit; they are not the production path.
    it("sets phase to error if session doesn't exist", async () => {
      mockSession(null);

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("sets phase to error if session has no creatorUid", async () => {
      mockSession({ created: Date.now() });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("reports SESSION_NOT_FOUND when the session read is denied", async () => {
      // The production shape, and the one the other two tests cannot reach.
      // `.read` is `created > now - 24h`; for a session that was never written
      // `created` is null and RTDB compares null to a number as false, so the
      // read is DENIED rather than resolving empty. Until this was classified
      // at the read itself, a mistyped code or a day-old link fell through to
      // the shared catch and told the user their browser was blocking storage.
      mockGet.mockRejectedValue(
        Object.assign(new Error("Permission denied"), {
          code: "PERMISSION_DENIED",
        }),
      );

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("does not claim SESSION_FULL when a refused slot stays empty", async () => {
      // The 2026-09-11 outage in miniature: the deployed rules had no `.write`
      // under `slots`, so every claim was denied while the session sat nearly
      // empty. claimSlot swallowed each rejection as a lost race, exhausted its
      // attempts and returned null — which joinSession reported as "session is
      // full (5 participants max)" about a session holding one person. A
      // refusal that leaves the index unheld is an error, not a race.
      mockSession(
        { created: Date.now(), creatorUid: "creator-uid" },
        { "0": "creator-uid" },
      );
      mockSet.mockRejectedValue(
        Object.assign(new Error("Permission denied"), {
          code: "PERMISSION_DENIED",
        }),
      );

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).not.toBe("SESSION_FULL");
      expect(result.current.error).toBe("JOIN_PERMISSION_DENIED");
    });

    it("advances to the next index when a claim genuinely loses the race", async () => {
      // The other side of the same distinction: refused, but somebody is in
      // the index afterwards. That one really is a lost race, and the claim
      // must move on rather than surface an error.
      const slots: Record<string, string> = { "0": "creator-uid" };
      mockSession({ created: Date.now(), creatorUid: "creator-uid" }, slots);
      mockSet.mockImplementationOnce(() => {
        slots["1"] = PARTNER_UID; // the winner's write lands first
        return Promise.reject(
          Object.assign(new Error("Permission denied"), {
            code: "PERMISSION_DENIED",
          }),
        );
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
      expect(result.current.ownIndex).toBe(2);
    });

    it("reports SESSION_FULL when all five slots are claimed", async () => {
      // The cap is now the database's: five write-once keys exist and every
      // one is taken by somebody else, so claimSlot has nothing to claim.
      mockSession(
        { created: Date.now(), creatorUid: "creator-uid" },
        {
          "0": "creator-uid",
          "1": PARTNER_UID,
          "2": PARTNER_UID_2,
          "3": PARTNER_UID_3,
          "4": PARTNER_UID_4,
        },
      );

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_FULL");
    });

    it("claims a slot and sets ownIndex on successful join", async () => {
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid" },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "sessions/XYZ789/slots/1",
        }),
        TEST_UID,
      );
      expect(result.current.ownIndex).toBeGreaterThanOrEqual(1);
      expect(result.current.code).toBe("XYZ789");
    });

    it("sets phase to 'connected' if another participant has data", async () => {
      const creatorUid = "creator-uid";
      mockSession({
        created: Date.now(),
        creatorUid,
        slots: { "0": creatorUid },
        participants: {
          [creatorUid]: {
            lat: 32.08,
            lng: 34.78,
            accuracy: 10,
            ts: Date.now(),
          },
        },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
    });

    it("sets phase to error if session is expired (>24h)", async () => {
      const expiredTime = Date.now() - 25 * 60 * 60 * 1000;
      mockSession({
        created: expiredTime,
        creatorUid: "creator-uid",
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_EXPIRED");
    });

    it("joins successfully if session is less than 24h old", async () => {
      const recentTime = Date.now() - 23 * 60 * 60 * 1000;
      mockSession({
        created: recentTime,
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid" },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
      expect(result.current.ownIndex).toBeGreaterThanOrEqual(1);
    });

    it("joins successfully if session has no created field (graceful)", async () => {
      mockSession({
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid" },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
      expect(result.current.ownIndex).toBeGreaterThanOrEqual(1);
    });

    it("rejects session at exact 24h boundary", async () => {
      const exactBoundary = Date.now() - 24 * 60 * 60 * 1000 - 1;
      mockSession({
        created: exactBoundary,
        creatorUid: "creator-uid",
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_EXPIRED");
    });

    it("sets phase to 'waiting' if no other participant has data", async () => {
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid" },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
    });

    it("reuses the slot it already holds when rejoining", async () => {
      mockSession(
        { created: Date.now(), creatorUid: "creator-uid" },
        { "0": "creator-uid", "1": TEST_UID },
      );

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("ready");
      expect(result.current.ownIndex).toBe(1);
      // Idempotent: holding a slot already means claiming nothing.
      expect(mockSet).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "sessions/XYZ789/slots/1" }),
        TEST_UID,
      );
    });
  });

  describe("App Check attestation classification", () => {
    it("does NOT relabel an opaque join failure when the token fetch fails", async () => {
      // Regression: this used to promote to JOIN_PERMISSION_DENIED, telling
      // the user their browser was blocking storage or attestation. With App
      // Check reporting ~89% of RTDB requests unverified, that promotion fired
      // on nearly every device and hid the real cause — it took a three-day
      // outage to notice the rules were simply stale. A failed attestation is
      // telemetry, not a verdict about the user's browser.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockAppCheck = { _appCheck: true };
      mockGetToken.mockRejectedValue(new Error("recaptcha blocked"));
      // Opaque error: matches neither permission nor network patterns,
      // so classifyJoinError returns the catch-all JOIN_FAILED.
      mockGet.mockRejectedValue(new Error("Something went wrong"));

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        const join = result.current.joinSession("XYZ789", live()).catch(() => {
          // joinSession rethrows after classifying — expected here
        });
        await vi.runAllTimersAsync();
        await join;
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("JOIN_FAILED");
      expect(mockGetToken).toHaveBeenCalledWith(mockAppCheck, false);

      vi.useRealTimers();
    });

    it("keeps the generic JOIN_FAILED when the token was obtained", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockAppCheck = { _appCheck: true };
      mockGet.mockRejectedValue(new Error("Something went wrong"));

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        const join = result.current.joinSession("XYZ789", live()).catch(() => {
          // rethrow expected
        });
        await vi.runAllTimersAsync();
        await join;
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("JOIN_FAILED");

      vi.useRealTimers();
    });

    it("never requests a token when App Check is not configured", async () => {
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid" },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(mockGetToken).not.toHaveBeenCalled();
    });
  });

  describe("listenForParticipants", () => {
    it("sets participants when other users appear", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      act(() => {
        onValueCallback?.({
          val: () => ({
            "0": {
              uid: TEST_UID,
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: 1000,
            },
            "1": {
              uid: PARTNER_UID,
              lat: 31.76,
              lng: 35.21,
              accuracy: 15,
              ts: Date.now(),
            },
          }),
        });
      });

      expect(result.current.participants).toHaveLength(1);
      expect(result.current.participants[0].position).toEqual({
        lat: 31.76,
        lng: 35.21,
      });
      expect(result.current.participants[0].accuracy).toBe(15);
      expect(result.current.status).toBe("ready");
    });

    it("handles multiple participants", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      const now = Date.now();
      act(() => {
        onValueCallback?.({
          val: () => ({
            "0": {
              uid: TEST_UID,
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: now,
            },
            "1": {
              uid: PARTNER_UID,
              lat: 31.76,
              lng: 35.21,
              accuracy: 15,
              ts: now,
            },
            "2": {
              uid: PARTNER_UID_2,
              lat: 31.5,
              lng: 34.9,
              accuracy: 20,
              ts: now,
            },
            "3": {
              uid: PARTNER_UID_3,
              lat: 32.1,
              lng: 35.0,
              accuracy: 12,
              ts: now,
            },
          }),
        });
      });

      expect(result.current.participants).toHaveLength(3);
      expect(result.current.status).toBe("ready");
    });

    it("clears participants when data is null", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      // First connect
      act(() => {
        onValueCallback?.({
          val: () => ({
            "0": {
              uid: TEST_UID,
              lat: 32.08,
              lng: 34.78,
              accuracy: 10,
              ts: 1000,
            },
            "1": {
              uid: PARTNER_UID,
              lat: 31.76,
              lng: 35.21,
              accuracy: 15,
              ts: Date.now(),
            },
          }),
        });
      });

      expect(result.current.status).toBe("ready");

      act(() => {
        onValueCallback?.({ val: () => null });
      });

      expect(result.current.participants).toEqual([]);
    });

    it("sets phase to error on connection error", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      act(() => {
        onValueErrorCallback?.(new Error("Permission denied"));
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("CONNECTION_ERROR");
    });

    it("only own uid in participants means no others found", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      act(() => {
        onValueCallback?.({
          val: () => ({
            [TEST_UID]: { lat: 32.08, lng: 34.78, accuracy: 10, ts: 1000 },
          }),
        });
      });

      expect(result.current.participants).toEqual([]);
      expect(result.current.status).toBe("ready");
    });
  });

  describe("cleanup", () => {
    it("removes own participant data from RTDB", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      act(() => {
        result.current.cleanup();
      });

      // Removal goes through the injected presence writer, keyed by the slot
      // we hold. The `slots/{i}` claim itself is deliberately left in place.
      expect(mockPresenceRemove).toHaveBeenCalledWith("ABC234", 0);
    });

    it("unsubscribes from onValue listener", async () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.createSession(live());
      });

      act(() => {
        result.current.cleanup();
      });

      expect(mockOnValueUnsub).toHaveBeenCalled();
    });

    it("does not remove presence if no session code", () => {
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      act(() => {
        result.current.cleanup();
      });

      expect(mockPresenceRemove).not.toHaveBeenCalled();
    });
  });

  describe("handshake cancellation", () => {
    it("reports an aborted create without recording a UI error", async () => {
      const controller = new AbortController();
      controller.abort();
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      let outcome: Awaited<
        ReturnType<typeof result.current.createSession>
      > | null = null;
      await act(async () => {
        outcome = await result.current.createSession(controller.signal);
      });

      // An unmount mid-handshake used to leave a three-attempt backoff running
      // against a dead component and then set error state on it.
      expect(outcome).toEqual({
        ok: false,
        error: { code: "CREATE_FAILED", details: "aborted" },
      });
      expect(result.current.error).toBeNull();
    });

    it("reports an aborted join without recording a UI error", async () => {
      const controller = new AbortController();
      controller.abort();
      const { result } = renderHook(() => useLiveSession(TEST_UID));

      let outcome: Awaited<
        ReturnType<typeof result.current.joinSession>
      > | null = null;
      await act(async () => {
        outcome = await result.current.joinSession("ABC234", controller.signal);
      });

      expect(outcome).toEqual({
        ok: false,
        error: { code: "JOIN_FAILED", details: "aborted" },
      });
      expect(result.current.error).toBeNull();
    });
  });
});

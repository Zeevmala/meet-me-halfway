import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveSession } from "./useLiveSession";
import { rememberSlot } from "../lib/slot-memory";

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
  // The RTDB sentinel, resolved server-side. `created` is stamped with it so
  // the TTL rule compares the server's clock against itself.
  serverTimestamp: () => SERVER_TIMESTAMP,
}));

const SERVER_TIMESTAMP = { ".sv": "timestamp" };

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

interface SessionPayload {
  created?: number;
  creatorUid?: string;
  slots?: Record<string, string>;
  participants?: Record<string, unknown>;
}

/**
 * Resolve `get` per path.
 *
 * Three paths matter. `sessions/{code}/created` is probed on its own — it
 * carries its own `.read` rule so the join can tell "no such session" from
 * "expired" from "actually refused". The session root is what the join and the
 * slot claim read. `sessions/{code}/slots` is kept for the callers that only
 * care about the claim; `slots` is merged into the root payload so the claim,
 * which reads slots *and* participants together, sees both.
 */
function mockSession(
  session: SessionPayload | null,
  slots: Record<string, string> = {},
) {
  mockGet.mockImplementation((r: { path?: string }) => {
    const path = r?.path ?? "";
    if (path.endsWith("/created")) {
      return Promise.resolve({ val: () => session?.created ?? null });
    }
    if (path.endsWith("/slots")) {
      return Promise.resolve({ val: () => slots });
    }
    return Promise.resolve({
      val: () =>
        session === null
          ? null
          : { ...session, slots: { ...session.slots, ...slots } },
    });
  });
}

/**
 * A session whose `created` reads fine but whose root read is refused — what
 * the TTL clause of the `.read` rule produces for an expired session, and the
 * only shape from which the client may infer SESSION_EXPIRED.
 */
function mockExpiredSession(created = Date.now() - 25 * 60 * 60 * 1000) {
  mockGet.mockImplementation((r: { path?: string }) => {
    if (r?.path?.endsWith("/created")) {
      return Promise.resolve({ val: () => created });
    }
    return Promise.reject(new Error("Permission denied"));
  });
}

const TEST_UID = "user-abc-123";
const PARTNER_UID = "user-xyz-789";
const PARTNER_UID_2 = "user-def-456";
const PARTNER_UID_3 = "user-ghi-012";
const PARTNER_UID_4 = "user-jkl-345";

beforeEach(() => {
  vi.clearAllMocks();
  // The slot memo is per-device state that outlives a render; without this a
  // slot remembered by one test steers the allocation in the next.
  localStorage.clear();
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
        SERVER_TIMESTAMP,
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

    // Regression: five claims with nobody behind them is exactly what one
    // person reloading five times produced, and it locked everybody out with
    // SESSION_FULL. Claims are now released by evidence of absence.
    it("does not report SESSION_FULL when all five claims are abandoned", async () => {
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

      expect(result.current.error).toBeNull();
      expect(result.current.status).toBe("ready");
      expect(result.current.ownIndex).toBe(1);
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

    // Regression: every one of these used to surface as
    // JOIN_PERMISSION_DENIED — "your browser may be blocking storage or
    // attestation" — because the `.read` rule on the session node denies a
    // session that is absent *or* expired, and a denial is a denial. The
    // separately readable `created` is what tells them apart.
    it("reports SESSION_EXPIRED when created reads but the session does not", async () => {
      mockExpiredSession();

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_EXPIRED");
    });

    it("reports SESSION_NOT_FOUND when created does not exist", async () => {
      // The share race: the link is live before the creator's writes land.
      mockSession(null);

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBe("SESSION_NOT_FOUND");
    });

    it("joins successfully when created is readable and the session is not refused", async () => {
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

    it("keeps JOIN_NETWORK_ERROR distinct from expiry when the session read fails offline", async () => {
      mockGet.mockImplementation((r: { path?: string }) => {
        if (r?.path?.endsWith("/created")) {
          return Promise.resolve({ val: () => Date.now() });
        }
        return Promise.reject(new Error("network request failed"));
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.error).toBe("JOIN_NETWORK_ERROR");
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

    // Regression: a claim used to be permanent. An anonymous uid that changes
    // between loads — iOS Safari evicting IndexedDB under ITP, or the
    // in-memory persistence fallback — therefore burned a slot per reload, and
    // five reloads by one person exhausted the session for everybody.
    it("reclaims a slot whose holder has no participant node", async () => {
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: {
          "0": "creator-uid",
          "1": "ghost-1",
          "2": "ghost-2",
          "3": "ghost-3",
          "4": "ghost-4",
        },
        participants: {
          "0": { uid: "creator-uid", lat: 32, lng: 34, accuracy: 5, ts: 1 },
          "2": { uid: "ghost-2", lat: 32, lng: 34, accuracy: 5, ts: 1 },
        },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      // Slots 1, 3 and 4 are claimed but nobody is in them; 1 is lowest.
      expect(result.current.ownIndex).toBe(1);
      expect(result.current.status).toBe("ready");
    });

    it("asks for the slot this device remembered, even though 1 is free", async () => {
      rememberSlot("XYZ789", 3);
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        // Slot 3 is still claimed by the uid this device had before its
        // anonymous identity was evicted; nobody is in it.
        slots: { "0": "creator-uid", "3": "my-previous-uid" },
        participants: {
          "0": { uid: "creator-uid", lat: 32, lng: 34, accuracy: 5, ts: 1 },
        },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.ownIndex).toBe(3);
    });

    it("ignores a remembered slot somebody else is actually in", async () => {
      rememberSlot("XYZ789", 3);
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: { "0": "creator-uid", "3": PARTNER_UID },
        participants: {
          "0": { uid: "creator-uid", lat: 32, lng: 34, accuracy: 5, ts: 1 },
          "3": { uid: PARTNER_UID, lat: 32, lng: 34, accuracy: 5, ts: 1 },
        },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.ownIndex).toBe(1);
    });

    it("prefers a free slot over one that is merely vacated", async () => {
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        // Slot 1 is claimed but its holder has not written a position yet —
        // a joiner arriving in that window must not displace them.
        slots: { "0": "creator-uid", "1": "just-joined" },
        participants: {
          "0": { uid: "creator-uid", lat: 32, lng: 34, accuracy: 5, ts: 1 },
        },
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.ownIndex).toBe(2);
    });

    it("still reports SESSION_FULL when every slot holder is present", async () => {
      const held = {
        "0": "creator-uid",
        "1": PARTNER_UID,
        "2": PARTNER_UID_2,
        "3": PARTNER_UID_3,
        "4": PARTNER_UID_4,
      };
      mockSession({
        created: Date.now(),
        creatorUid: "creator-uid",
        slots: held,
        participants: Object.fromEntries(
          Object.entries(held).map(([slot, uid]) => [
            slot,
            { uid, lat: 32, lng: 34, accuracy: 5, ts: 1 },
          ]),
        ),
      });

      const { result } = renderHook(() => useLiveSession(TEST_UID));

      await act(async () => {
        await result.current.joinSession("XYZ789", live());
      });

      expect(result.current.error).toBe("SESSION_FULL");
    });
  });

  describe("App Check attestation classification", () => {
    it("promotes an opaque join failure to JOIN_PERMISSION_DENIED when the token fetch fails", async () => {
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
      expect(result.current.error).toBe("JOIN_PERMISSION_DENIED");
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

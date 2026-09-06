import { useCallback, useEffect, useRef, useState } from "react";
import {
  onValue,
  onDisconnect,
  ref,
  remove,
  set,
  get,
} from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { getToken, type AppCheck } from "firebase/app-check";
import * as Sentry from "@sentry/react";
import { useFirebase } from "../../../hooks/useFirebase";
import { generateCode } from "../lib/session-code";
import {
  getOrCreateDisplayName,
  sanitizeName,
  saveDisplayName,
} from "../lib/display-name";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import { backoffDelayMs } from "../../../core/dag/backoff";
import { createSlotRegistry } from "../lib/slot-registry";
import type { SlotRegistry } from "../lib/slot-registry";
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import { classifyJoinError, describeError } from "../lib/error-classification";
import { detectInAppBrowser } from "../lib/in-app-browser";

/** Typed error codes — avoids fragile string matching in the UI layer. */
export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_FULL"
  | "SESSION_EXPIRED"
  | "CREATE_FAILED"
  | "JOIN_FAILED"
  | "JOIN_PERMISSION_DENIED"
  | "JOIN_NETWORK_ERROR"
  | "CONNECTION_ERROR";

export type SessionPhase =
  "idle" | "creating" | "waiting" | "connected" | "some_stale" | "error";

interface ParticipantData {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
  name?: string;
}

/** Info about another participant in the session. */
export interface ParticipantInfo {
  uid: string;
  position: LatLng;
  accuracy: number;
  lastSeen: number;
  index: ParticipantIndex;
  stale: boolean;
  name: string | null;
}

export interface LiveSessionState {
  phase: SessionPhase;
  code: string | null;
  /** Session creator's uid — the anchor for stable slot allocation. */
  creatorUid: string | null;
  ownIndex: ParticipantIndex | null;
  ownPosition: LatLng | null;
  ownName: string;
  participants: ParticipantInfo[];
  error: SessionErrorCode | null;
  /** Raw underlying error description — shown in the UI "Details" expander
   * and useful when users report a failure. */
  errorDetails: string | null;
  createSession: () => Promise<string>;
  joinSession: (code: string) => Promise<void>;
  updateOwnLocation: (pos: LatLng, accuracy: number) => void;
  setOwnName: (name: string) => void;
  cleanup: () => void;
}

const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 10_000;
const WRITE_THROTTLE_MS = 3_000;
// Note: TTL is only enforced on join. A creator with the page open
// beyond 24h will continue operating — acceptable for MVP since RTDB
// security rules can enforce server-side TTL in a future iteration.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Max time to wait for the initial App Check token before proceeding
// anyway. In-app browsers can hang the reCAPTCHA fetch indefinitely.
const APP_CHECK_TIMEOUT_MS = 5_000;

// Retry transient Firebase failures with exponential backoff (1s, 2s)
// before surfacing the error. Most flake on iOS Safari resolves within
// ~3s; this means users rarely see the error screen at all.
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  isRetryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isRetryable(err)) {
        await new Promise((r) =>
          setTimeout(r, backoffDelayMs(i, { baseMs: 1000 })),
        );
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/** Permission errors won't recover via retry — bail immediately. */
function isTransientError(err: unknown): boolean {
  return classifyJoinError(err) !== "JOIN_PERMISSION_DENIED";
}

/**
 * Best-effort wait for the first App Check token. If App Check is not
 * configured, resolves immediately. If reCAPTCHA hangs, times out so we
 * don't block the join forever.
 *
 * Returns `true` if a token was obtained (or App Check isn't configured),
 * `false` if attestation failed/timed out. The caller uses this to
 * disambiguate an otherwise-opaque RTDB failure: when App Check is enforced
 * server-side and our token never arrived, the database rejects the request
 * with an HTTP 401 the SDK surfaces with an unhelpful message — so a token
 * failure is a strong signal the downstream error is an attestation block.
 */
async function waitForAppCheckToken(
  appCheck: AppCheck | null,
): Promise<boolean> {
  if (!appCheck) return true;
  try {
    await Promise.race([
      getToken(appCheck, /* forceRefresh */ false),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("appcheck_timeout")),
          APP_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
    return true;
  } catch (err) {
    console.warn("[session] App Check token wait failed:", err);
    Sentry.captureMessage("appcheck_token_wait_failed", {
      level: "warning",
      extra: { error: describeError(err) },
    });
    // Proceed anyway — server may still accept the request if App Check is
    // unenforced. If it is enforced, the caller reclassifies the failure.
    return false;
  }
}

/**
 * Build Sentry context for a session-flow failure.
 *
 * `hasAppCheck` now reports whether attestation is actually *running*, not
 * merely whether a site key was configured. The two diverge exactly when it
 * matters — a blocked reCAPTCHA script in an in-app browser leaves the key set
 * and App Check off — which is the case these reports exist to diagnose.
 */
function sessionContext(code: string | null, hasAppCheck: boolean) {
  return {
    session: {
      // Don't ship the full code — keep PII low. The first 2 chars are
      // enough to correlate with our own debug reports.
      codePrefix: code ? code.slice(0, 2) : null,
      online: typeof navigator !== "undefined" ? navigator.onLine : null,
      inAppBrowser: detectInAppBrowser(),
      hasAppCheck,
    },
  };
}

/**
 * Manages a live session backed by Firebase RTDB.
 *
 * RTDB schema:
 *   sessions/{code}/created            — timestamp
 *   sessions/{code}/creatorUid         — uid of session creator
 *   sessions/{code}/participantUids/{uid} — true (write-once per participant)
 *   sessions/{code}/participants/{uid} — { lat, lng, accuracy, ts }
 *
 * @param uid  Firebase Anonymous Auth uid (from useAuth)
 */
export function useLiveSession(uid: string): LiveSessionState {
  const { db, appCheck } = useFirebase();

  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [creatorUid, setCreatorUid] = useState<string | null>(null);
  const [ownIndex, setOwnIndex] = useState<ParticipantIndex | null>(null);
  const [ownPosition, setOwnPosition] = useState<LatLng | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [error, setError] = useState<SessionErrorCode | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [ownName, setOwnNameState] = useState<string>(() =>
    getOrCreateDisplayName(),
  );

  const unsubRef = useRef<Unsubscribe | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeRef = useRef<string | null>(null);
  const creatorUidRef = useRef<string | null>(null);
  // Slot allocation is first-seen-wins and lasts the whole session, so it must
  // survive re-renders. See lib/slot-registry.ts.
  const slotRegistryRef = useRef<SlotRegistry | null>(null);

  // Throttle refs for RTDB write limiting
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWriteRef = useRef<number>(0);
  const pendingWriteRef = useRef<{
    pos: LatLng;
    accuracy: number;
  } | null>(null);

  // Latest known own position/accuracy — used to flush a name change
  // immediately even if no GPS update is pending.
  const ownPositionRef = useRef<LatLng | null>(null);
  const lastAccuracyRef = useRef<number | null>(null);

  // Guard so we register the server-side onDisconnect cleanup only once
  // per session (firing it repeatedly on every write is wasteful).
  const disconnectArmedRef = useRef(false);

  // Keep code ref in sync with state for cleanup
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  /** Listen for all participant updates. */
  const listenForParticipants = useCallback(
    (sessionCode: string) => {
      const participantsRef = ref(db, `sessions/${sessionCode}/participants`);

      unsubRef.current = onValue(
        participantsRef,
        (snap) => {
          const data = snap.val() as Record<string, ParticipantData> | null;
          if (!data) {
            setParticipants([]);
            return;
          }

          let registry = slotRegistryRef.current;
          if (!registry) {
            registry = createSlotRegistry(creatorUidRef.current ?? "");
            slotRegistryRef.current = registry;
          }
          // Allocate over the whole snapshot, own uid included, so a slot
          // never depends on who happens to be present in this frame.
          registry.assignAll(Object.keys(data));

          // Build participant list excluding self
          const others: ParticipantInfo[] = [];
          for (const [participantUid, participant] of Object.entries(data)) {
            if (participantUid === uid) continue;
            const slot = registry.slotOf(participantUid);
            // Every slot taken: drop rather than alias onto an occupied one
            // (the old out-of-range clamp silently collided here).
            if (slot === null) continue;
            others.push({
              uid: participantUid,
              position: { lat: participant.lat, lng: participant.lng },
              accuracy: participant.accuracy,
              lastSeen: participant.ts,
              index: slot,
              stale: Date.now() - participant.ts > STALE_THRESHOLD_MS,
              name: sanitizeName(participant.name),
            });
          }

          others.sort((a, b) => a.index - b.index);
          setParticipants(others);

          if (others.length > 0) {
            const anyStale = others.some((p) => p.stale);
            setPhase(anyStale ? "some_stale" : "connected");
          } else {
            // No other participants with data — go to waiting if we were connected
            setPhase((prev) =>
              prev === "connected" || prev === "some_stale" ? "waiting" : prev,
            );
          }
        },
        (err) => {
          console.error("[session] participants listener error:", err);
          Sentry.captureException(err, {
            tags: { phase: "listen", classified: classifyJoinError(err) },
            contexts: sessionContext(codeRef.current, appCheck !== null),
          });
          setErrorDetails(describeError(err));
          setError("CONNECTION_ERROR");
          setPhase("error");
        },
      );
    },
    [db, uid, appCheck],
  );

  /** Start stale detection interval. */
  const startStaleDetection = useCallback(() => {
    if (staleTimerRef.current) clearInterval(staleTimerRef.current);

    staleTimerRef.current = setInterval(() => {
      setParticipants((prev) => {
        const now = Date.now();
        let changed = false;
        const updated = prev.map((p) => {
          const stale = now - p.lastSeen > STALE_THRESHOLD_MS;
          if (stale !== p.stale) changed = true;
          return stale !== p.stale ? { ...p, stale } : p;
        });

        if (changed) {
          const anyStale = updated.some((p) => p.stale);
          setPhase((prev) =>
            prev === "connected" || prev === "some_stale"
              ? anyStale
                ? "some_stale"
                : "connected"
              : prev,
          );
          return updated;
        }
        return prev;
      });
    }, STALE_CHECK_INTERVAL_MS);
  }, []);

  /** Create a new live session as the creator (index 0). */
  const createSession = useCallback(async (): Promise<string> => {
    setError(null);
    setErrorDetails(null);

    const sessionCode = generateCode();

    // Make UI usable immediately — share button works even if RTDB is slow/offline.
    // The code is locally generated; the writes below sync to the server when reachable.
    creatorUidRef.current = uid;
    setCreatorUid(uid);
    const creatorRegistry = createSlotRegistry(uid);
    slotRegistryRef.current = creatorRegistry;
    creatorRegistry.assign(uid);
    setCode(sessionCode);
    setOwnIndex(0);
    setPhase("waiting");

    const url = new URL(window.location.href);
    url.searchParams.set("code", sessionCode);
    history.replaceState(null, "", url.toString());

    try {
      await waitForAppCheckToken(appCheck);
      await withRetry(
        async () => {
          await set(ref(db, `sessions/${sessionCode}/created`), Date.now());
          await set(ref(db, `sessions/${sessionCode}/creatorUid`), uid);
          await set(
            ref(db, `sessions/${sessionCode}/participantUids/${uid}`),
            true,
          );
        },
        3,
        isTransientError,
      );

      // Attach the listener only after `created` exists: the `.read` rule
      // requires `created > now - 24h`, so a listener attached before the
      // write is evaluated against a session with no `created` and is
      // rejected with permission_denied (joinSession is safe because it
      // reads an already-created session).
      listenForParticipants(sessionCode);
      startStaleDetection();

      return sessionCode;
    } catch (err) {
      console.error("[session] create failed:", err);
      Sentry.captureException(err, {
        tags: { phase: "create", classified: classifyJoinError(err) },
        contexts: sessionContext(sessionCode, appCheck !== null),
      });
      setErrorDetails(describeError(err));
      setPhase("error");
      setError("CREATE_FAILED");
      throw err;
    }
  }, [db, uid, appCheck, listenForParticipants, startStaleDetection]);

  /** Join an existing session. */
  const joinSession = useCallback(
    async (sessionCode: string): Promise<void> => {
      setPhase("creating");
      setError(null);
      setErrorDetails(null);

      let appCheckOk = true;
      try {
        appCheckOk = await waitForAppCheckToken(appCheck);

        const sessionRef = ref(db, `sessions/${sessionCode}`);
        const snap = await withRetry(
          () => get(sessionRef),
          3,
          isTransientError,
        );
        const data = snap.val() as {
          created?: number;
          creatorUid?: string;
          participantUids?: Record<string, boolean>;
          participants?: Record<string, ParticipantData>;
        } | null;

        if (!data || !data.creatorUid) {
          setPhase("error");
          setError("SESSION_NOT_FOUND");
          return;
        }

        // Check if session has expired (24h TTL)
        if (data.created && Date.now() - data.created > SESSION_TTL_MS) {
          setPhase("error");
          setError("SESSION_EXPIRED");
          return;
        }

        // Check participant count
        const existingUids = data.participantUids
          ? Object.keys(data.participantUids)
          : [];
        if (
          existingUids.length >= MAX_PARTICIPANTS &&
          !existingUids.includes(uid)
        ) {
          setPhase("error");
          setError("SESSION_FULL");
          return;
        }

        // Register as participant
        if (!existingUids.includes(uid)) {
          await withRetry(
            () =>
              set(
                ref(db, `sessions/${sessionCode}/participantUids/${uid}`),
                true,
              ),
            3,
            isTransientError,
          );
        }

        creatorUidRef.current = data.creatorUid;
        setCreatorUid(data.creatorUid);
        const registry = createSlotRegistry(data.creatorUid);
        slotRegistryRef.current = registry;
        // Seed from participantUids (the write-once registration set) rather
        // than from participants (only those who have reported a position).
        // The two diverge while somebody is registered but has no fix yet,
        // and ranking own over one set while ranking others over the other is
        // exactly how two participants used to end up sharing a slot.
        registry.assignAll([...new Set([...existingUids, uid])]);
        const myIndex = registry.slotOf(uid);

        setCode(sessionCode);
        setOwnIndex(myIndex);

        // If any other participant already has location data, we're connected
        const hasOtherData =
          data.participants &&
          Object.keys(data.participants).some((k) => k !== uid);
        setPhase(hasOtherData ? "connected" : "waiting");

        listenForParticipants(sessionCode);
        startStaleDetection();
      } catch (err) {
        let classified = classifyJoinError(err);
        // App Check enforced + no token → the RTDB rejection is an attestation
        // block (HTTP 401) the SDK reports with an opaque message. Promote the
        // generic failure so the user gets actionable guidance instead.
        if (classified === "JOIN_FAILED" && !appCheckOk) {
          classified = "JOIN_PERMISSION_DENIED";
        }
        console.error("[session] join failed:", err, "→", classified);
        Sentry.captureException(err, {
          tags: { phase: "join", classified, appCheckOk: String(appCheckOk) },
          contexts: sessionContext(sessionCode, appCheck !== null),
        });
        setErrorDetails(describeError(err));
        setPhase("error");
        setError(classified);
        throw err;
      }
    },
    [db, uid, appCheck, listenForParticipants, startStaleDetection],
  );

  /** Flush a buffered position write to RTDB. */
  const flushWrite = useCallback(
    (pos: LatLng, accuracy: number) => {
      if (!codeRef.current) return;
      const ownRef = ref(db, `sessions/${codeRef.current}/participants/${uid}`);

      // Arm a server-side cleanup: when this client's socket drops (tab close,
      // crash, network loss — none of which reliably fire beforeunload on
      // mobile), Firebase removes our participant node. Without this, a
      // departed participant lingers and keeps dragging the computed midpoint.
      if (!disconnectArmedRef.current) {
        disconnectArmedRef.current = true;
        onDisconnect(ownRef)
          .remove()
          .catch(() => {
            disconnectArmedRef.current = false; // allow a retry on next write
          });
      }

      set(ownRef, {
        lat: pos.lat,
        lng: pos.lng,
        accuracy,
        ts: Date.now(),
        name: getOrCreateDisplayName(),
      }).catch(() => {
        /* best-effort write */
      });
      lastWriteRef.current = Date.now();
      pendingWriteRef.current = null;
    },
    [db, uid],
  );

  /**
   * Write own location to Firebase under participants/{uid}.
   * Throttled: max 1 RTDB write per 3s (leading + trailing edge).
   * Local state always updates immediately for UI responsiveness.
   */
  const updateOwnLocation = useCallback(
    (pos: LatLng, accuracy: number) => {
      setOwnPosition(pos);
      ownPositionRef.current = pos;
      lastAccuracyRef.current = accuracy;

      if (!codeRef.current) return;

      const elapsed = Date.now() - lastWriteRef.current;

      if (elapsed >= WRITE_THROTTLE_MS) {
        // Leading edge: write immediately
        flushWrite(pos, accuracy);
      } else {
        // Buffer the latest position for trailing edge
        pendingWriteRef.current = { pos, accuracy };

        if (!throttleTimerRef.current) {
          throttleTimerRef.current = setTimeout(() => {
            throttleTimerRef.current = null;
            if (pendingWriteRef.current) {
              flushWrite(
                pendingWriteRef.current.pos,
                pendingWriteRef.current.accuracy,
              );
            }
          }, WRITE_THROTTLE_MS - elapsed);
        }
      }
    },
    [flushWrite],
  );

  // Flush the current position once the session code becomes active.
  // Geolocation can deliver its (sometimes only) fix before the async join
  // sets the code, in which case updateOwnLocation skipped the write with no
  // code yet. Without this, a stationary joiner with a single GPS fix never
  // writes participants/{uid} and peers never see them.
  useEffect(() => {
    if (code && ownPositionRef.current && lastAccuracyRef.current !== null) {
      flushWrite(ownPositionRef.current, lastAccuracyRef.current);
    }
  }, [code, flushWrite]);

  /**
   * Update the local display name. Persists to localStorage and triggers
   * an immediate RTDB write if we already have a position to attach.
   */
  const setOwnName = useCallback(
    (raw: string) => {
      const next = saveDisplayName(raw);
      setOwnNameState(next);
      if (
        codeRef.current &&
        ownPositionRef.current &&
        lastAccuracyRef.current !== null
      ) {
        flushWrite(ownPositionRef.current, lastAccuracyRef.current);
      }
    },
    [flushWrite],
  );

  /** Remove own data from RTDB. Called on beforeunload + unmount. */
  const cleanup = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    if (staleTimerRef.current) {
      clearInterval(staleTimerRef.current);
      staleTimerRef.current = null;
    }
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    pendingWriteRef.current = null;
    slotRegistryRef.current = null;
    // Reset the guard but leave the onDisconnect armed — it is the reliable
    // backstop if this explicit remove() doesn't complete during unload.
    disconnectArmedRef.current = false;

    if (codeRef.current) {
      const ownRef = ref(db, `sessions/${codeRef.current}/participants/${uid}`);
      // Firebase RTDB sends the remove over WebSocket immediately;
      // it completes even if the page is unloading.
      remove(ownRef).catch(() => {
        /* best effort on unload */
      });
    }
  }, [db, uid]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    phase,
    code,
    creatorUid,
    ownIndex,
    ownPosition,
    ownName,
    participants,
    error,
    errorDetails,
    createSession,
    joinSession,
    updateOwnLocation,
    setOwnName,
    cleanup,
  };
}

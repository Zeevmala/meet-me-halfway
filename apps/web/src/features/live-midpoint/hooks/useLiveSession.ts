import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, set, get } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { getToken, type AppCheck } from "firebase/app-check";
import * as Sentry from "@sentry/react";
import { useFirebase } from "../../../hooks/useFirebase";
import { useServices } from "../../../components/ServicesProvider";
import { generateCode } from "../lib/session-code";
import {
  getOrCreateDisplayName,
  sanitizeName,
  saveDisplayName,
} from "../lib/display-name";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import type { SessionStatus } from "../graph/types";
import { ok, err } from "../../../core/dag/result";
import type { Result } from "../../../core/dag/result";
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

interface ParticipantData {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
  name?: string;
}

/**
 * Info about another participant in the session.
 *
 * No `stale` flag: staleness is `now - lastSeen > threshold`, derived by the
 * graph's `liveness` node. Computing it here meant it could only change when
 * something pushed, which is why it needed a polling interval.
 */
export interface ParticipantInfo {
  uid: string;
  position: LatLng;
  accuracy: number;
  lastSeen: number;
  index: ParticipantIndex;
  name: string | null;
}

/** Why a session handshake failed, and what the raw error said. */
export interface SessionFailure {
  readonly code: SessionErrorCode;
  readonly details: string | null;
}

export interface LiveSessionState {
  /**
   * Lifecycle only. The phase the UI renders is derived by the graph from
   * this plus the roster and liveness — see `derivePhase`.
   */
  status: SessionStatus;
  code: string | null;
  /** Session creator's uid — the anchor for stable slot allocation. */
  creatorUid: string | null;
  ownIndex: ParticipantIndex | null;
  ownName: string;
  participants: ParticipantInfo[];
  error: SessionErrorCode | null;
  /** Raw underlying error description — shown in the UI "Details" expander
   * and useful when users report a failure. */
  errorDetails: string | null;
  /**
   * Both return a Result rather than throwing.
   *
   * They used to throw, and the page called them from an effect with no
   * `.catch()` — so every failed join produced an unhandled rejection and a
   * duplicate Sentry event on top of the one raised deliberately. `Result` is
   * also what the rest of the codebase uses for fallible work.
   *
   * The signal cancels the retry loop: an unmount mid-join previously left a
   * three-attempt backoff running against a dead component.
   */
  createSession: (
    signal: AbortSignal,
  ) => Promise<Result<string, SessionFailure>>;
  joinSession: (
    code: string,
    signal: AbortSignal,
  ) => Promise<Result<string, SessionFailure>>;
  setOwnName: (name: string) => void;
  cleanup: () => void;
}

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
  signal: AbortSignal,
  attempts = 3,
  isRetryable: (err: unknown) => boolean = () => true,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isRetryable(err)) {
        await sleep(backoffDelayMs(i, { baseMs: 1000 }), signal);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

/** Abortable delay, so a teardown does not have to wait out the backoff. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(id);
      resolve();
    };
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  const { presence } = useServices();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [creatorUid, setCreatorUid] = useState<string | null>(null);
  const [ownIndex, setOwnIndex] = useState<ParticipantIndex | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [error, setError] = useState<SessionErrorCode | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [ownName, setOwnNameState] = useState<string>(() =>
    getOrCreateDisplayName(),
  );

  const unsubRef = useRef<Unsubscribe | null>(null);
  const codeRef = useRef<string | null>(null);
  const creatorUidRef = useRef<string | null>(null);
  // Slot allocation is first-seen-wins and lasts the whole session, so it must
  // survive re-renders. See lib/slot-registry.ts.
  const slotRegistryRef = useRef<SlotRegistry | null>(null);

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
              name: sanitizeName(participant.name),
            });
          }

          others.sort((a, b) => a.index - b.index);
          // Whether this means waiting, connected or some_stale is the graph's
          // to decide. Six `setPhase` call sites used to answer it here, one of
          // them from inside a `setParticipants` updater — where React requires
          // purity and StrictMode double-invokes.
          setParticipants(others);
        },
        (err) => {
          console.error("[session] participants listener error:", err);
          Sentry.captureException(err, {
            tags: { phase: "listen", classified: classifyJoinError(err) },
            contexts: sessionContext(codeRef.current, appCheck !== null),
          });
          setErrorDetails(describeError(err));
          setError("CONNECTION_ERROR");
          setStatus("error");
        },
      );
    },
    [db, uid, appCheck],
  );

  /** Record a handshake failure once, in the shape the UI and the caller need. */
  const fail = useCallback(
    (code: SessionErrorCode, details: string | null): SessionFailure => {
      setErrorDetails(details);
      setError(code);
      setStatus("error");
      return { code, details };
    },
    [],
  );

  /** Create a new live session as the creator (index 0). */
  const createSession = useCallback(
    async (signal: AbortSignal): Promise<Result<string, SessionFailure>> => {
      setError(null);
      setErrorDetails(null);

      const sessionCode = generateCode();

      // Make the UI usable immediately — the share button works even if RTDB
      // is slow or offline. The code is generated locally; the writes below
      // sync when the server is reachable.
      creatorUidRef.current = uid;
      setCreatorUid(uid);
      const creatorRegistry = createSlotRegistry(uid);
      slotRegistryRef.current = creatorRegistry;
      creatorRegistry.assign(uid);
      setCode(sessionCode);
      setOwnIndex(0);
      setStatus("ready");

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
          signal,
          3,
          isTransientError,
        );

        // Attach the listener only after `created` exists: the `.read` rule
        // requires `created > now - 24h`, so a listener attached before the
        // write is evaluated against a session with no `created` and is
        // rejected with permission_denied. (joinSession is safe because it
        // reads an already-created session.)
        listenForParticipants(sessionCode);

        return ok(sessionCode);
      } catch (thrown) {
        if (signal.aborted) {
          return err({ code: "CREATE_FAILED", details: "aborted" });
        }
        console.error("[session] create failed:", thrown);
        Sentry.captureException(thrown, {
          tags: { phase: "create", classified: classifyJoinError(thrown) },
          contexts: sessionContext(sessionCode, appCheck !== null),
        });
        return err(fail("CREATE_FAILED", describeError(thrown)));
      }
    },
    [db, uid, appCheck, listenForParticipants, fail],
  );

  /** Join an existing session. */
  const joinSession = useCallback(
    async (
      sessionCode: string,
      signal: AbortSignal,
    ): Promise<Result<string, SessionFailure>> => {
      setStatus("connecting");
      setError(null);
      setErrorDetails(null);

      let appCheckOk = true;
      try {
        appCheckOk = await waitForAppCheckToken(appCheck);

        const sessionRef = ref(db, `sessions/${sessionCode}`);
        const snap = await withRetry(
          () => get(sessionRef),
          signal,
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
          return err(fail("SESSION_NOT_FOUND", null));
        }

        if (data.created && Date.now() - data.created > SESSION_TTL_MS) {
          return err(fail("SESSION_EXPIRED", null));
        }

        const existingUids = data.participantUids
          ? Object.keys(data.participantUids)
          : [];
        if (
          existingUids.length >= MAX_PARTICIPANTS &&
          !existingUids.includes(uid)
        ) {
          return err(fail("SESSION_FULL", null));
        }

        if (!existingUids.includes(uid)) {
          await withRetry(
            () =>
              set(
                ref(db, `sessions/${sessionCode}/participantUids/${uid}`),
                true,
              ),
            signal,
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
        // The two diverge while somebody is registered but has no fix yet, and
        // ranking own over one set while ranking others over the other is
        // exactly how two participants used to end up sharing a slot.
        registry.assignAll([...new Set([...existingUids, uid])]);

        setCode(sessionCode);
        setOwnIndex(registry.slotOf(uid));
        setStatus("ready");

        listenForParticipants(sessionCode);
        return ok(sessionCode);
      } catch (thrown) {
        if (signal.aborted) {
          return err({ code: "JOIN_FAILED", details: "aborted" });
        }
        let classified = classifyJoinError(thrown);
        // App Check enforced + no token → the RTDB rejection is an attestation
        // block (HTTP 401) the SDK reports with an opaque message. Promote the
        // generic failure so the user gets actionable guidance instead.
        if (classified === "JOIN_FAILED" && !appCheckOk) {
          classified = "JOIN_PERMISSION_DENIED";
        }
        console.error("[session] join failed:", thrown, "→", classified);
        Sentry.captureException(thrown, {
          tags: { phase: "join", classified, appCheckOk: String(appCheckOk) },
          contexts: sessionContext(sessionCode, appCheck !== null),
        });
        return err(fail(classified, describeError(thrown)));
      }
    },
    [db, uid, appCheck, listenForParticipants, fail],
  );

  /**
   * Update the local display name.
   *
   * Persisted to localStorage and pushed into state; the `presence` node picks
   * it up on the next tick and writes it, because a name change is one of its
   * admission conditions. This used to reach for a cached position and call
   * the writer directly.
   */
  const setOwnName = useCallback((raw: string) => {
    setOwnNameState(saveDisplayName(raw));
  }, []);

  /** Detach the listener and remove own presence. */
  const cleanup = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    slotRegistryRef.current = null;

    if (codeRef.current) {
      // The write side is the graph's; removal is not a derivation, so it
      // stays here. `onDisconnect` remains armed server-side as the backstop
      // if this does not complete during unload.
      presence.remove(codeRef.current, uid);
    }
  }, [presence, uid]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    status,
    code,
    creatorUid,
    ownIndex,
    ownName,
    participants,
    error,
    errorDetails,
    createSession,
    joinSession,
    setOwnName,
    cleanup,
  };
}

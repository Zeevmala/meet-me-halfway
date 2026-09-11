import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, set, get, serverTimestamp } from "firebase/database";
import type { Database } from "firebase/database";
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
import { MAX_PARTICIPANTS } from "../lib/participant-config";
import { classifyJoinError, describeError } from "../lib/error-classification";
import { detectInAppBrowser } from "../lib/in-app-browser";
import { recallSlot, rememberSlot } from "../lib/slot-memory";

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
  uid: string;
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

// Note: the 24h TTL is enforced by the `.read` rule on `sessions/{code}`,
// against the server's clock and a server-stamped `created`. There is
// deliberately no client-side comparison: `Date.now()` on the joiner's device
// is not the clock the rule uses, so a second opinion here could only ever
// disagree with the one that decides.

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

/** `sessions/{code}/slots` as RTDB stores it: slot key → holder uid. */
type SlotMap = Partial<Record<string, string>>;

/**
 * Slot 0 is tried last in both passes, so "the creator is green" survives as
 * the normal outcome without being a rule that can strand the slot.
 */
const CLAIM_ORDER: readonly ParticipantIndex[] = [1, 2, 3, 4, 0];

/**
 * Claim a slot, letting the database arbitrate.
 *
 * The rule *is* the arbitration: two clients racing for the same index are
 * serialised by the server, and the loser's `set` is rejected with
 * permission_denied. So there is no transaction and no client-side registry —
 * we try the indices in order and re-read on a rejection.
 *
 * A claim is no longer permanent. It is writable while the index is free
 * **or** while its `participants/{i}` node is absent, which is the database's
 * own evidence that whoever held it is gone — `onDisconnect` clears that node
 * when their socket drops. Without this an anonymous uid that changes between
 * loads (iOS Safari evicts IndexedDB under ITP, and the in-memory persistence
 * fallback mints a fresh uid on every load) burned a slot per reload: the old
 * claim survived forever holding a uid that would never write again, so the
 * same person came back a different colour, their previous marker never
 * updated, and five reloads exhausted a session for everybody in it.
 *
 * Free indices are tried before vacated ones, so a live participant who is
 * merely between heartbeats is never displaced while an empty slot exists.
 * The one exception is the slot this device remembers holding in this session:
 * a reload under a fresh uid asks for that one back first, which is what keeps
 * somebody the same colour across the identity change that caused the problem.
 *
 * @returns the claimed slot, or `null` when all five are held by participants
 *   who are actually present — a fact about the session, not a guess.
 */
async function claimSlot(
  db: Database,
  sessionCode: string,
  uid: string,
): Promise<ParticipantIndex | null> {
  const sessionRef = ref(db, `sessions/${sessionCode}`);
  const remembered = recallSlot(sessionCode);

  // At most one attempt per slot: every rejection means somebody else took
  // that index, so the loop strictly makes progress.
  for (let attempt = 0; attempt < MAX_PARTICIPANTS; attempt++) {
    const snap = await get(sessionRef);
    const data = (snap.val() ?? {}) as {
      slots?: SlotMap;
      participants?: Partial<Record<string, unknown>>;
    };
    const slots = data.slots ?? {};
    const participants = data.participants ?? {};

    // Idempotent rejoin: we may already hold one from a previous mount.
    for (const [key, holder] of Object.entries(slots)) {
      if (holder === uid) {
        rememberSlot(sessionCode, Number(key) as ParticipantIndex);
        return Number(key) as ParticipantIndex;
      }
    }

    const isFree = (slot: ParticipantIndex) =>
      slots[String(slot)] === undefined;
    const isVacated = (slot: ParticipantIndex) =>
      !isFree(slot) && participants[String(slot)] === undefined;

    const candidates = [
      // Our own previous slot, if the database agrees nobody is in it. Only on
      // the first attempt: a rejection means somebody else now holds it, and
      // asking again would be a loop rather than progress.
      ...(attempt === 0 &&
      remembered !== null &&
      (isFree(remembered) || isVacated(remembered))
        ? [remembered]
        : []),
      ...CLAIM_ORDER.filter(isFree),
      ...CLAIM_ORDER.filter(isVacated),
    ];

    const target = candidates[0];
    if (target === undefined) return null;

    try {
      await set(ref(db, `sessions/${sessionCode}/slots/${target}`), uid);
      rememberSlot(sessionCode, target);
      return target;
    } catch {
      // Lost the race — re-read and try the next candidate.
    }
  }
  return null;
}

/**
 * Manages a live session backed by Firebase RTDB.
 *
 * RTDB schema:
 *   sessions/{code}/created        — server timestamp (write-once)
 *   sessions/{code}/creatorUid     — uid of session creator (write-once)
 *   sessions/{code}/slots/{0..4}   — uid (exactly five keys; see claimSlot)
 *   sessions/{code}/participants/{slot} — { uid, lat, lng, accuracy, ts, name }
 *
 * The five fixed slot keys are what enforces MAX_PARTICIPANTS. The rules
 * reject any key outside 0..4, so the cap is a property of the schema rather
 * than a client-side check that a modified client could simply skip. A slot is
 * writable only while it is free or its `participants/{i}` node is gone, so a
 * claim is released by evidence of absence rather than never.
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
  // The slot we hold, kept in a ref so cleanup can remove the right node
  // after the component has stopped rendering.
  const ownSlotRef = useRef<ParticipantIndex | null>(null);

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

          // Keyed by slot now, so there is no allocation to do here at all:
          // the key *is* the index, arbitrated by the database when the slot
          // was claimed. The registry this replaces derived an index from
          // whatever snapshot each client happened to hold.
          const others: ParticipantInfo[] = [];
          for (const [slotKey, participant] of Object.entries(data)) {
            if (participant.uid === uid) continue;
            const slot = Number(slotKey);
            // The rules cannot produce a key outside 0..4, but a snapshot is
            // still untrusted input to this process.
            if (
              !Number.isInteger(slot) ||
              slot < 0 ||
              slot >= MAX_PARTICIPANTS
            ) {
              continue;
            }
            others.push({
              uid: participant.uid,
              position: { lat: participant.lat, lng: participant.lng },
              accuracy: participant.accuracy,
              lastSeen: participant.ts,
              index: slot as ParticipantIndex,
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
      ownSlotRef.current = 0;
      // Remembered before the write lands: a reload mid-handshake still comes
      // back to slot 0 rather than taking a second one.
      rememberSlot(sessionCode, 0);
      setCode(sessionCode);
      setOwnIndex(0);
      setStatus("ready");

      const url = new URL(window.location.href);
      url.searchParams.set("code", sessionCode);
      history.replaceState(null, "", url.toString());

      try {
        await waitForAppCheckToken(appCheck);
        // Retried per write, not as a block. `created` and `creatorUid` are
        // write-once, so a block retry re-issued a write that had already
        // landed and the rule rejected it with permission_denied — turning a
        // transient failure on the third write into a terminal CREATE_FAILED
        // over a session that was two-thirds written and, from then on,
        // unjoinable by anyone holding the link.
        //
        // `created` is stamped by the server. It used to be `Date.now()`,
        // which the `.read` rule then compared against the server's clock: a
        // device a day slow created a session the very next read rejected —
        // for every joiner and for the creator's own listener.
        await withRetry(
          () =>
            set(ref(db, `sessions/${sessionCode}/created`), serverTimestamp()),
          signal,
          3,
          isTransientError,
        );
        await withRetry(
          () => set(ref(db, `sessions/${sessionCode}/creatorUid`), uid),
          signal,
          3,
          isTransientError,
        );
        await withRetry(
          () => set(ref(db, `sessions/${sessionCode}/slots/0`), uid),
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

        // Probe `created` on its own first. The `.read` rule on the session
        // node requires it to exist *and* be inside the TTL, so a session that
        // was never created, one that has expired, and a client the server
        // genuinely refuses were all one indistinguishable permission_denied —
        // reported to the user as "your browser may be blocking storage or
        // attestation" for what is usually a mistyped or stale link. `created`
        // carries its own `.read: auth != null`, so these are now three
        // answers rather than one.
        const createdSnap = await withRetry(
          () => get(ref(db, `sessions/${sessionCode}/created`)),
          signal,
          3,
          isTransientError,
        );
        if (typeof createdSnap.val() !== "number") {
          return err(fail("SESSION_NOT_FOUND", null));
        }

        const sessionRef = ref(db, `sessions/${sessionCode}`);
        let snap;
        try {
          snap = await withRetry(
            () => get(sessionRef),
            signal,
            3,
            isTransientError,
          );
        } catch (thrown) {
          // `created` read fine a moment ago, so auth and attestation are
          // working and the session exists. The TTL clause is the only term of
          // the session's `.read` rule left that can have failed.
          if (classifyJoinError(thrown) === "JOIN_PERMISSION_DENIED") {
            return err(fail("SESSION_EXPIRED", null));
          }
          throw thrown;
        }

        const data = snap.val() as {
          created?: number;
          creatorUid?: string;
          slots?: Record<string, string>;
          participants?: Record<string, ParticipantData>;
        } | null;

        if (!data || !data.creatorUid) {
          return err(fail("SESSION_NOT_FOUND", null));
        }

        // No client-side count: the database decides. `claimSlot` returns null
        // only when all five slots are held by participants who are actually
        // present, which is a fact about the session rather than this client's
        // view of it.
        const slot = await withRetry(
          () => claimSlot(db, sessionCode, uid),
          signal,
          3,
          isTransientError,
        );
        if (slot === null) {
          return err(fail("SESSION_FULL", null));
        }

        creatorUidRef.current = data.creatorUid;
        setCreatorUid(data.creatorUid);
        ownSlotRef.current = slot;

        setCode(sessionCode);
        setOwnIndex(slot);
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
    // Read, never clear. Clearing here and then gating the removal on it made
    // cleanup non-idempotent: a second call — which React will make whenever
    // this callback's identity changes — found a null slot and skipped the
    // removal, leaving our participant node behind to drag the midpoint.
    // `remove` is itself idempotent, so running twice costs nothing.
    const slot = ownSlotRef.current;

    if (codeRef.current !== null && slot !== null) {
      // The write side is the graph's; removal is not a derivation, so it
      // stays here. Only `participants/{slot}` goes — the `slots/{i}` claim is
      // write-once and stays, so a reconnect comes back to the same slot and
      // the same colour. `onDisconnect` is the backstop if this does not
      // complete during unload.
      presence.remove(codeRef.current, slot);
    }
  }, [presence]);

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

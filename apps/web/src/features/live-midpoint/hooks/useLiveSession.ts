import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, remove, set, get } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { useFirebase } from "../../../hooks/useFirebase";
import { generateCode } from "../lib/session-code";
import type { LatLng } from "../lib/geo-math";
import type { ParticipantIndex } from "../lib/participant-config";
import { MAX_PARTICIPANTS } from "../lib/participant-config";

/** Typed error codes — avoids fragile string matching in the UI layer. */
export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_FULL"
  | "SESSION_EXPIRED"
  | "CREATE_FAILED"
  | "JOIN_FAILED"
  | "CONNECTION_ERROR";

export type SessionPhase =
  | "idle"
  | "creating"
  | "waiting"
  | "connected"
  | "some_stale"
  | "error";

interface ParticipantData {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
}

/** Info about another participant in the session. */
export interface ParticipantInfo {
  uid: string;
  position: LatLng;
  accuracy: number;
  lastSeen: number;
  index: ParticipantIndex;
  stale: boolean;
}

export interface LiveSessionState {
  phase: SessionPhase;
  code: string | null;
  ownIndex: ParticipantIndex | null;
  ownPosition: LatLng | null;
  participants: ParticipantInfo[];
  error: SessionErrorCode | null;
  createSession: () => Promise<string>;
  joinSession: (code: string) => Promise<void>;
  updateOwnLocation: (pos: LatLng, accuracy: number) => void;
  cleanup: () => void;
}

const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 10_000;
const WRITE_THROTTLE_MS = 3_000;
// Note: TTL is only enforced on join. A creator with the page open
// beyond 24h will continue operating — acceptable for MVP since RTDB
// security rules can enforce server-side TTL in a future iteration.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Assign a ParticipantIndex based on UID position in sorted UID list.
 * Creator UID always gets index 0; others sorted lexicographically.
 */
function assignIndex(
  uid: string,
  creatorUid: string,
  allUids: string[],
): ParticipantIndex {
  if (uid === creatorUid) return 0;
  const others = allUids.filter((u) => u !== creatorUid).sort();
  const idx = others.indexOf(uid) + 1; // 1-based since creator is 0
  return Math.min(idx, MAX_PARTICIPANTS - 1) as ParticipantIndex;
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
  const { db } = useFirebase();

  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [ownIndex, setOwnIndex] = useState<ParticipantIndex | null>(null);
  const [ownPosition, setOwnPosition] = useState<LatLng | null>(null);
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [error, setError] = useState<SessionErrorCode | null>(null);

  const unsubRef = useRef<Unsubscribe | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeRef = useRef<string | null>(null);
  const creatorUidRef = useRef<string | null>(null);

  // Throttle refs for RTDB write limiting
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWriteRef = useRef<number>(0);
  const pendingWriteRef = useRef<{
    pos: LatLng;
    accuracy: number;
  } | null>(null);

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

          const creatorUid = creatorUidRef.current ?? "";
          const allUids = Object.keys(data);

          // Build participant list excluding self
          const others: ParticipantInfo[] = [];
          for (const [participantUid, participant] of Object.entries(data)) {
            if (participantUid !== uid) {
              others.push({
                uid: participantUid,
                position: { lat: participant.lat, lng: participant.lng },
                accuracy: participant.accuracy,
                lastSeen: participant.ts,
                index: assignIndex(participantUid, creatorUid, allUids),
                stale: Date.now() - participant.ts > STALE_THRESHOLD_MS,
              });
            }
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
        () => {
          setError("CONNECTION_ERROR");
          setPhase("error");
        },
      );
    },
    [db, uid],
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
    setPhase("creating");
    setError(null);

    const sessionCode = generateCode();

    try {
      // Write session metadata
      await set(ref(db, `sessions/${sessionCode}/created`), Date.now());
      await set(ref(db, `sessions/${sessionCode}/creatorUid`), uid);
      await set(
        ref(db, `sessions/${sessionCode}/participantUids/${uid}`),
        true,
      );

      creatorUidRef.current = uid;
      setCode(sessionCode);
      setOwnIndex(0);
      setPhase("waiting");

      // Update URL without reload
      const url = new URL(window.location.href);
      url.searchParams.set("code", sessionCode);
      history.replaceState(null, "", url.toString());

      listenForParticipants(sessionCode);
      startStaleDetection();

      return sessionCode;
    } catch (err) {
      setPhase("error");
      setError("CREATE_FAILED");
      throw err;
    }
  }, [db, uid, listenForParticipants, startStaleDetection]);

  /** Join an existing session. */
  const joinSession = useCallback(
    async (sessionCode: string): Promise<void> => {
      setPhase("creating");
      setError(null);

      try {
        const sessionRef = ref(db, `sessions/${sessionCode}`);
        const snap = await get(sessionRef);
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
          await set(
            ref(db, `sessions/${sessionCode}/participantUids/${uid}`),
            true,
          );
        }

        creatorUidRef.current = data.creatorUid;
        const allUids = [...existingUids.filter((u) => u !== uid), uid];
        const myIndex = assignIndex(uid, data.creatorUid, allUids);

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
        setPhase("error");
        setError("JOIN_FAILED");
        throw err;
      }
    },
    [db, uid, listenForParticipants, startStaleDetection],
  );

  /** Flush a buffered position write to RTDB. */
  const flushWrite = useCallback(
    (pos: LatLng, accuracy: number) => {
      if (!codeRef.current) return;
      const ownRef = ref(db, `sessions/${codeRef.current}/participants/${uid}`);
      set(ownRef, {
        lat: pos.lat,
        lng: pos.lng,
        accuracy,
        ts: Date.now(),
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
    ownIndex,
    ownPosition,
    participants,
    error,
    createSession,
    joinSession,
    updateOwnLocation,
    cleanup,
  };
}

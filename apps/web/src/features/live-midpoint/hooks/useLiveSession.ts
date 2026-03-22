import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, remove, set, get } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { useFirebase } from "../../../hooks/useFirebase";
import { generateCode } from "../lib/session-code";
import type { LatLng } from "../lib/geo-math";

/** Display role used for CSS classes and position mapping. */
export type Role = "a" | "b";

export type SessionPhase =
  | "idle"
  | "creating"
  | "waiting"
  | "connected"
  | "partner_stale"
  | "error";

interface ParticipantData {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
}

export interface LiveSessionState {
  phase: SessionPhase;
  code: string | null;
  role: Role | null;
  ownPosition: LatLng | null;
  partnerPosition: LatLng | null;
  partnerAccuracy: number | null;
  partnerLastSeen: number | null;
  error: string | null;
  createSession: () => Promise<string>;
  joinSession: (code: string) => Promise<void>;
  updateOwnLocation: (pos: LatLng, accuracy: number) => void;
  cleanup: () => void;
}

const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 10_000;
const WRITE_THROTTLE_MS = 3_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Manages a live session backed by Firebase RTDB.
 *
 * RTDB schema:
 *   sessions/{code}/created       — timestamp
 *   sessions/{code}/creatorUid    — uid of session creator
 *   sessions/{code}/joinerUid     — uid of session joiner
 *   sessions/{code}/participants/{uid} — { lat, lng, accuracy, ts }
 *
 * @param uid  Firebase Anonymous Auth uid (from useAuth)
 */
export function useLiveSession(uid: string): LiveSessionState {
  const { db } = useFirebase();

  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [ownPosition, setOwnPosition] = useState<LatLng | null>(null);
  const [partnerPosition, setPartnerPosition] = useState<LatLng | null>(null);
  const [partnerAccuracy, setPartnerAccuracy] = useState<number | null>(null);
  const [partnerLastSeen, setPartnerLastSeen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unsubRef = useRef<Unsubscribe | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const codeRef = useRef<string | null>(null);

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

  /** Listen for partner updates by watching the entire participants node. */
  const listenForPartner = useCallback(
    (sessionCode: string) => {
      const participantsRef = ref(db, `sessions/${sessionCode}/participants`);

      unsubRef.current = onValue(
        participantsRef,
        (snap) => {
          const data = snap.val() as Record<string, ParticipantData> | null;
          if (!data) {
            setPartnerPosition(null);
            setPartnerAccuracy(null);
            setPartnerLastSeen(null);
            return;
          }

          // Find partner: the participant whose key !== our uid
          let found = false;
          for (const [participantUid, participant] of Object.entries(data)) {
            if (participantUid !== uid) {
              setPartnerPosition({
                lat: participant.lat,
                lng: participant.lng,
              });
              setPartnerAccuracy(participant.accuracy);
              setPartnerLastSeen(participant.ts);
              setPhase("connected");
              found = true;
              break;
            }
          }

          if (!found) {
            setPartnerPosition(null);
            setPartnerAccuracy(null);
            setPartnerLastSeen(null);
            // Only go to waiting if we were connected before (partner left)
            setPhase((prev) =>
              prev === "connected" || prev === "partner_stale"
                ? "waiting"
                : prev,
            );
          }
        },
        (err) => {
          setError(`Connection error: ${err.message}`);
          setPhase("error");
        },
      );
    },
    [db, uid],
  );

  /** Start stale-partner detection interval. */
  const startStaleDetection = useCallback(() => {
    if (staleTimerRef.current) clearInterval(staleTimerRef.current);

    staleTimerRef.current = setInterval(() => {
      setPartnerLastSeen((ts) => {
        if (ts !== null && Date.now() - ts > STALE_THRESHOLD_MS) {
          setPhase((prev) => (prev === "connected" ? "partner_stale" : prev));
        }
        return ts;
      });
    }, STALE_CHECK_INTERVAL_MS);
  }, []);

  /** Create a new live session as the creator (display role "a"). */
  const createSession = useCallback(async (): Promise<string> => {
    setPhase("creating");
    setError(null);

    const sessionCode = generateCode();

    try {
      // Write session metadata
      await set(ref(db, `sessions/${sessionCode}/created`), Date.now());
      await set(ref(db, `sessions/${sessionCode}/creatorUid`), uid);

      setCode(sessionCode);
      setRole("a");
      setPhase("waiting");

      // Update URL without reload
      const url = new URL(window.location.href);
      url.searchParams.set("code", sessionCode);
      history.replaceState(null, "", url.toString());

      listenForPartner(sessionCode);
      startStaleDetection();

      return sessionCode;
    } catch (err) {
      setPhase("error");
      setError("Failed to create session.");
      throw err;
    }
  }, [db, uid, listenForPartner, startStaleDetection]);

  /** Join an existing session as the joiner (display role "b"). */
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
          joinerUid?: string;
          participants?: Record<string, ParticipantData>;
        } | null;

        if (!data || !data.creatorUid) {
          setPhase("error");
          setError("Session not found.");
          return;
        }

        // Check if session has expired (24h TTL)
        if (data.created && Date.now() - data.created > SESSION_TTL_MS) {
          setPhase("error");
          setError("Session expired.");
          return;
        }

        // Check if joiner slot is taken
        if (data.joinerUid) {
          setPhase("error");
          setError("Session already has two participants.");
          return;
        }

        // Claim the joiner slot
        await set(ref(db, `sessions/${sessionCode}/joinerUid`), uid);

        setCode(sessionCode);
        setRole("b");

        // If creator already has a participant entry, we're connected
        const hasCreatorData =
          data.participants &&
          Object.keys(data.participants).some((k) => k === data.creatorUid);
        setPhase(hasCreatorData ? "connected" : "waiting");

        listenForPartner(sessionCode);
        startStaleDetection();
      } catch (err) {
        setPhase("error");
        setError("Failed to join session.");
        throw err;
      }
    },
    [db, uid, listenForPartner, startStaleDetection],
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
    role,
    ownPosition,
    partnerPosition,
    partnerAccuracy,
    partnerLastSeen,
    error,
    createSession,
    joinSession,
    updateOwnLocation,
    cleanup,
  };
}

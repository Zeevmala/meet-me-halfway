import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref, remove, set, get } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { useFirebase } from "../../../hooks/useFirebase";
import { generateCode } from "../lib/session-code";
import type { LatLng } from "../lib/geo-math";

export type Role = "a" | "b";
export type SessionPhase =
  | "idle"
  | "creating"
  | "waiting"
  | "connected"
  | "partner_stale"
  | "error";

interface PartnerData {
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

const STALE_THRESHOLD_MS = 60_000;
const STALE_CHECK_INTERVAL_MS = 10_000;

export function useLiveSession(): LiveSessionState {
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
  const roleRef = useRef<Role | null>(null);

  // Keep refs in sync with state for cleanup
  useEffect(() => {
    codeRef.current = code;
  }, [code]);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  const partnerRole = (r: Role): Role => (r === "a" ? "b" : "a");

  /** Listen for partner updates via Firebase RTDB. */
  const listenForPartner = useCallback(
    (sessionCode: string, myRole: Role) => {
      const partnerRef = ref(
        db,
        `live-sessions/${sessionCode}/${partnerRole(myRole)}`,
      );

      unsubRef.current = onValue(
        partnerRef,
        (snap) => {
          const data = snap.val() as PartnerData | null;
          if (data) {
            setPartnerPosition({ lat: data.lat, lng: data.lng });
            setPartnerAccuracy(data.accuracy);
            setPartnerLastSeen(data.ts);
            setPhase("connected");
          } else {
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
          console.warn("[LiveSession] Firebase listener error:", err.message);
          setError("Connection error. Please try again.");
          setPhase("error");
        },
      );
    },
    [db],
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

  /** Create a new live session as role A. */
  const createSession = useCallback(async (): Promise<string> => {
    setPhase("creating");
    setError(null);

    const sessionCode = generateCode();

    try {
      // Write a created timestamp to claim the session
      await set(ref(db, `live-sessions/${sessionCode}/created`), Date.now());

      setCode(sessionCode);
      setRole("a");
      setPhase("waiting");

      // Update URL without reload
      const url = new URL(window.location.href);
      url.searchParams.set("code", sessionCode);
      history.replaceState(null, "", url.toString());

      listenForPartner(sessionCode, "a");
      startStaleDetection();

      return sessionCode;
    } catch (err) {
      setPhase("error");
      setError("Failed to create session.");
      throw err;
    }
  }, [db, listenForPartner, startStaleDetection]);

  /** Join an existing session as role B. */
  const joinSession = useCallback(
    async (sessionCode: string): Promise<void> => {
      setPhase("creating");
      setError(null);

      const sessionRef = ref(db, `live-sessions/${sessionCode}`);

      try {
        const snap = await get(sessionRef);
        const data = snap.val();

        if (!data) {
          setPhase("error");
          setError("Session not found.");
          return;
        }

        // Check if slot b is taken
        if (data.b) {
          setPhase("error");
          setError("Session already has two participants.");
          return;
        }

        setCode(sessionCode);
        setRole("b");
        setPhase(data.a ? "connected" : "waiting");

        listenForPartner(sessionCode, "b");
        startStaleDetection();
      } catch (err) {
        setPhase("error");
        setError("Failed to join session.");
        throw err;
      }
    },
    [db, listenForPartner, startStaleDetection],
  );

  /** Write own location to Firebase. */
  const updateOwnLocation = useCallback(
    (pos: LatLng, accuracy: number) => {
      setOwnPosition(pos);

      if (!codeRef.current || !roleRef.current) return;

      const ownRef = ref(
        db,
        `live-sessions/${codeRef.current}/${roleRef.current}`,
      );
      set(ownRef, {
        lat: pos.lat,
        lng: pos.lng,
        accuracy,
        ts: Date.now(),
      }).catch((err) => {
        console.warn("[LiveSession] Failed to write location:", err.message);
      });
    },
    [db],
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

    if (codeRef.current && roleRef.current) {
      const ownRef = ref(
        db,
        `live-sessions/${codeRef.current}/${roleRef.current}`,
      );
      // Firebase RTDB sends the remove over WebSocket immediately;
      // it completes even if the page is unloading.
      remove(ownRef).catch(() => {
        /* best effort on unload */
      });
    }
  }, [db]);

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

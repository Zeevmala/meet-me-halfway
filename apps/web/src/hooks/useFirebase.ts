import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getDatabase, onValue, ref, type Database } from "firebase/database";
import { useEffect, useMemo, useState } from "react";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

function getFirebaseApp(): FirebaseApp {
  if (getApps().length === 0) {
    return initializeApp(firebaseConfig);
  }
  return getApps()[0];
}

export function useFirebase(): { app: FirebaseApp; db: Database } {
  return useMemo(() => {
    const app = getFirebaseApp();
    const db = getDatabase(app);
    return { app, db };
  }, []);
}

export interface ParticipantRTDB {
  lat: number;
  lng: number;
  display_name: string;
  updated_at: string;
}

export function useParticipantLocations(
  sessionId: string | null,
): Record<string, ParticipantRTDB> {
  const [participants, setParticipants] = useState<
    Record<string, ParticipantRTDB>
  >({});

  useEffect(() => {
    if (!sessionId) return;

    const db = getDatabase(getFirebaseApp());
    const participantsRef = ref(db, `/sessions/${sessionId}/participants`);

    const unsubscribe = onValue(
      participantsRef,
      (snapshot) => {
        const data = snapshot.val() as Record<string, ParticipantRTDB> | null;
        setParticipants(data ?? {});
      },
      (error) => {
        // Firebase listener error — log and degrade gracefully
        // API polling in useSession will serve as fallback
        console.warn("[Firebase] Realtime listener error:", error.message);
        setParticipants({});
      },
    );

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return participants;
}

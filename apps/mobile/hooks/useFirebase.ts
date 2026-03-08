import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getDatabase, onValue, ref } from "firebase/database";
import { useEffect, useState } from "react";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
};

function getFirebaseApp(): FirebaseApp {
  if (getApps().length === 0) {
    return initializeApp(firebaseConfig);
  }
  return getApps()[0];
}

export interface ParticipantRTDB {
  lat: number;
  lng: number;
  display_name: string;
  updated_at: string;
}

export function useParticipantLocations(
  sessionId: string | null
): Record<string, ParticipantRTDB> {
  const [participants, setParticipants] = useState<Record<string, ParticipantRTDB>>({});

  useEffect(() => {
    if (!sessionId) return;

    const db = getDatabase(getFirebaseApp());
    const participantsRef = ref(db, `/sessions/${sessionId}/participants`);

    const unsubscribe = onValue(participantsRef, (snapshot) => {
      const data = snapshot.val() as Record<string, ParticipantRTDB> | null;
      setParticipants(data ?? {});
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  return participants;
}

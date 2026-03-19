import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "firebase/app-check";
import { getDatabase, type Database } from "firebase/database";
import { useMemo } from "react";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

function getFirebaseApp(): FirebaseApp {
  if (getApps().length === 0) {
    // Enable App Check debug token in development
    if (import.meta.env.DEV) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }

    const app = initializeApp(firebaseConfig);

    // App Check must initialize before auth/RTDB operations
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(
        import.meta.env.VITE_RECAPTCHA_SITE_KEY,
      ),
      isTokenAutoRefreshEnabled: true,
    });

    return app;
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

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  inMemoryPersistence,
  type Auth,
} from "firebase/auth";
import { getDatabase, type Database } from "firebase/database";
import * as Sentry from "@sentry/react";
import { useMemo } from "react";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  // Required for App Check: the token exchange posts to /apps/{appId}/… and
  // returns HTTP 400 for every client when absent.
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let appCheckInstance: AppCheck | null = null;
let authInstance: Auth | null = null;

function getFirebaseApp(): FirebaseApp {
  if (getApps().length === 0) {
    const app = initializeApp(firebaseConfig);

    // App Check — optional; needs BOTH the reCAPTCHA site key and the
    // Firebase appId (attestation can only 400 without the app resource).
    if (
      import.meta.env.VITE_RECAPTCHA_SITE_KEY &&
      !import.meta.env.VITE_FIREBASE_APP_ID
    ) {
      console.warn(
        "[firebase] VITE_RECAPTCHA_SITE_KEY is set but VITE_FIREBASE_APP_ID is missing — App Check disabled.",
      );
    }
    if (
      import.meta.env.VITE_RECAPTCHA_SITE_KEY &&
      import.meta.env.VITE_FIREBASE_APP_ID
    ) {
      try {
        appCheckInstance = initializeAppCheck(app, {
          provider: new ReCaptchaEnterpriseProvider(
            import.meta.env.VITE_RECAPTCHA_SITE_KEY,
          ),
          isTokenAutoRefreshEnabled: true,
        });
      } catch (err) {
        // Init can throw in in-app browsers that block the reCAPTCHA script.
        // Continue without App Check — RTDB will still work if rules allow.
        console.warn("[firebase] App Check init failed:", err);
        Sentry.captureMessage("appcheck_init_failed", {
          level: "warning",
          extra: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return app;
  }
  return getApps()[0];
}

/**
 * Auth singleton with an explicit persistence fallback chain. The SDK
 * probes each layer and skips unavailable ones, so strict-privacy browsers
 * that block IndexedDB/localStorage degrade to in-memory auth instead of
 * failing sign-in outright.
 */
function getFirebaseAuth(app: FirebaseApp): Auth {
  if (authInstance) return authInstance;
  try {
    authInstance = initializeAuth(app, {
      // No popupRedirectResolver — anonymous auth only.
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        inMemoryPersistence,
      ],
    });
  } catch (err) {
    // Defense-in-depth for browsers where storage access throws
    // synchronously. In-memory auth means a reload mints a new anonymous
    // UID, consuming a fresh write-once participantUids slot (5-slot cap).
    console.warn("[firebase] persistent auth init failed:", err);
    try {
      authInstance = initializeAuth(app, { persistence: inMemoryPersistence });
      Sentry.setTag("auth_persistence", "memory");
      Sentry.captureMessage("auth_memory_persistence_fallback", {
        level: "warning",
        extra: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      // auth/already-initialized (e.g. Vite HMR re-eval) — reuse the
      // existing instance.
      authInstance = getAuth(app);
    }
  }
  return authInstance;
}

export function useFirebase(): {
  app: FirebaseApp;
  db: Database;
  auth: Auth;
  appCheck: AppCheck | null;
} {
  return useMemo(() => {
    const app = getFirebaseApp();
    const db = getDatabase(app);
    const auth = getFirebaseAuth(app);
    return { app, db, auth, appCheck: appCheckInstance };
  }, []);
}

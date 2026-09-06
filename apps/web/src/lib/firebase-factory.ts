/**
 * Firebase services as a factory, not a module singleton.
 *
 * `hooks/useFirebase.ts` previously held `authInstance` and `appCheckInstance`
 * as module-level mutable state and performed App Check initialisation as a
 * side effect of a getter — the exact pattern `graph/runtime.ts` rejects in its
 * own header, and the reason every hook that touches Firebase can only be
 * tested by mocking `firebase/database` at the module level.
 *
 * Singleton-ness now comes from *being called once*, at the composition root,
 * rather than from hidden state here. Firebase's own `getApps()` guard remains
 * because Vite HMR re-evaluates modules and the SDK throws on a duplicate app.
 */
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
import type { AppConfig } from "./config";

export interface FirebaseServices {
  readonly app: FirebaseApp;
  readonly db: Database;
  readonly auth: Auth;
  /** `null` when App Check is unconfigured or its script was blocked. */
  readonly appCheck: AppCheck | null;
}

function createApp(config: AppConfig): FirebaseApp {
  const existing = getApps()[0];
  if (existing !== undefined) return existing;
  return initializeApp({
    apiKey: config.firebase.apiKey,
    authDomain: config.firebase.authDomain,
    databaseURL: config.firebase.databaseURL,
    projectId: config.firebase.projectId,
    appId: config.firebase.appId,
  });
}

/**
 * App Check needs **both** the reCAPTCHA site key and the Firebase appId —
 * attestation can only 400 without the app resource, so initialising with one
 * of the two produces a failure on every client rather than a degraded mode.
 */
function createAppCheck(app: FirebaseApp, config: AppConfig): AppCheck | null {
  const siteKey = config.recaptchaSiteKey;
  if (siteKey === null) return null;

  if (config.firebase.appId === undefined) {
    console.warn(
      "[firebase] VITE_RECAPTCHA_SITE_KEY is set but VITE_FIREBASE_APP_ID is missing — App Check disabled.",
    );
    return null;
  }

  try {
    return initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    // Init throws in in-app browsers that block the reCAPTCHA script.
    // Continue without App Check — RTDB still works if the rules allow it.
    console.warn("[firebase] App Check init failed:", err);
    Sentry.captureMessage("appcheck_init_failed", {
      level: "warning",
      extra: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

/**
 * Auth with an explicit persistence fallback chain. The SDK probes each layer
 * and skips unavailable ones, so strict-privacy browsers that block IndexedDB
 * and localStorage degrade to in-memory auth instead of failing sign-in.
 *
 * Tradeoff, unchanged: under in-memory persistence a reload mints a new
 * anonymous UID and consumes a fresh write-once `participantUids` slot.
 */
function createAuth(app: FirebaseApp): Auth {
  try {
    return initializeAuth(app, {
      // No popupRedirectResolver — anonymous auth only.
      persistence: [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        inMemoryPersistence,
      ],
    });
  } catch (err) {
    // Defense in depth for browsers where storage access throws synchronously.
    console.warn("[firebase] persistent auth init failed:", err);
    try {
      const auth = initializeAuth(app, { persistence: inMemoryPersistence });
      Sentry.setTag("auth_persistence", "memory");
      Sentry.captureMessage("auth_memory_persistence_fallback", {
        level: "warning",
        extra: { error: err instanceof Error ? err.message : String(err) },
      });
      return auth;
    } catch {
      // auth/already-initialized (e.g. Vite HMR re-eval) — reuse it.
      return getAuth(app);
    }
  }
}

export function createFirebaseServices(config: AppConfig): FirebaseServices {
  const app = createApp(config);
  return {
    app,
    db: getDatabase(app),
    auth: createAuth(app),
    appCheck: createAppCheck(app, config),
  };
}

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
  getToken,
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
import {
  connectDatabaseEmulator,
  forceWebSockets,
  getDatabase,
  type Database,
} from "firebase/database";
import * as Sentry from "@sentry/react";
import type { AppConfig } from "./config";

/**
 * How the first attestation attempt of this page load ended.
 *
 * Carried as a value rather than a boolean because the three failure modes
 * need different responses and the Firebase console cannot tell them apart:
 * `timeout` means reCAPTCHA works here but is slower than our budget,
 * `error` means it is blocked or rejected on this device, and `no-appcheck`
 * means we never configured it. A verified-request percentage alone leaves
 * you guessing between them, which is how 89% unverified went undiagnosed.
 */
export type AttestationOutcome =
  | { readonly ok: true; readonly reason: "token"; readonly latencyMs: number }
  | {
      readonly ok: false;
      readonly reason: "no-appcheck" | "timeout" | "error";
    };

/**
 * How long to wait for the first App Check token before giving up on it.
 *
 * Nothing the user looks at waits on this — only the first RTDB subscription
 * does (see `useNetworkStatus`), and the offline banner it feeds already
 * debounces 6s before it will say anything. So the budget trades attestation
 * coverage against how long a genuinely blocked device stalls its own
 * handshake, not against first paint.
 */
export const APP_CHECK_TIMEOUT_MS = 5_000;

export interface FirebaseServices {
  readonly app: FirebaseApp;
  readonly db: Database;
  readonly auth: Auth;
  /** `null` when App Check is unconfigured or its script was blocked. */
  readonly appCheck: AppCheck | null;
  /**
   * Settles when the first attestation attempt finishes, and **never rejects**.
   *
   * Anything that would open the RTDB connection awaits this first. RTDB sends
   * the App Check token when it establishes its socket, so a socket opened
   * before the first token exists is unattested for its lifetime — which is
   * what put 89% of requests in the unverified column while attestation itself
   * was working fine.
   */
  readonly appCheckReady: Promise<AttestationOutcome>;
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
 * Start attestation immediately and report how it went.
 *
 * Deliberately fire-and-forget rather than awaited by `createServices`: the
 * fetch overlaps module loading, i18n init, React's first render and the
 * geolocation prompt, so priming costs no first paint. Only the code that
 * would open the RTDB socket awaits the result.
 *
 * Resolves rather than rejects on every path. A blocked or slow reCAPTCHA must
 * degrade to unattested traffic, never to an unhandled rejection or a hung
 * app — the same posture the auth persistence chain takes one function below.
 */
export function primeAppCheck(
  appCheck: AppCheck | null,
  timeoutMs: number = APP_CHECK_TIMEOUT_MS,
): Promise<AttestationOutcome> {
  if (appCheck === null)
    return Promise.resolve(report({ ok: false, reason: "no-appcheck" }));

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attested = getToken(appCheck, /* forceRefresh */ false).then(
    (): AttestationOutcome => ({
      ok: true,
      reason: "token",
      latencyMs: Date.now() - startedAt,
    }),
    (err): AttestationOutcome => {
      console.warn("[firebase] App Check token fetch failed:", err);
      return { ok: false, reason: "error" };
    },
  );

  const expired = new Promise<AttestationOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, reason: "timeout" }),
      timeoutMs,
    );
  });

  return Promise.race([attested, expired]).then((outcome) => {
    clearTimeout(timer);
    return report(outcome);
  });
}

/**
 * Tag the session with the outcome so the residual is attributable.
 *
 * Session-scoped fact, hence a global tag: paired with the `inAppBrowser` tag
 * the session reports, it separates "reCAPTCHA is slow on this network" from
 * "reCAPTCHA is blocked on this device". Neither is visible in the console's
 * verified/unverified split.
 */
function report(outcome: AttestationOutcome): AttestationOutcome {
  Sentry.setTag("appcheck_outcome", outcome.reason);
  if (outcome.ok) {
    Sentry.setTag("appcheck_latency_ms", String(outcome.latencyMs));
  }
  return outcome;
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

/**
 * Split `host:port`. Throws rather than guessing a default port, so a
 * misconfigured e2e build fails at startup instead of as a connection that
 * never opens.
 */
export function parseEmulatorHost(value: string): {
  host: string;
  port: number;
} {
  const separator = value.lastIndexOf(":");
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `VITE_RTDB_EMULATOR_HOST must be host:port, got "${value}"`,
    );
  }
  return { host, port };
}

/**
 * What the Realtime Database SDK would read on this device when it picks a
 * transport: the flag it leaves in localStorage when a WebSocket closes before
 * it was proven healthy, or storage that throws, which it treats the same.
 *
 * Reported, not acted on — `forceWebSockets` below makes it moot. It is there
 * so the field can say how many devices the long-polling trap would have held.
 */
export type WebSocketHistory =
  "clean" | "previously-failed" | "storage-blocked";

/** The SDK's storage prefix plus the flag's name, as `WebSocketConnection` writes it. */
const WEBSOCKET_FAILURE_KEY = "firebase:previous_websocket_failure";

export function readWebSocketHistory(
  storage: () => Storage = () => window.localStorage,
): WebSocketHistory {
  try {
    return storage().getItem(WEBSOCKET_FAILURE_KEY) === "true"
      ? "previously-failed"
      : "clean";
  } catch {
    // Safari with all cookies blocked throws on the localStorage accessor.
    return "storage-blocked";
  }
}

/**
 * The Database handle, pointed at the emulator when the e2e build asks for it.
 * `connectDatabaseEmulator` must run before the first `ref()` starts the
 * connection, which is why it lives here and nowhere downstream.
 *
 * WebSockets only. The SDK's other transport is long-polling over JSONP —
 * `<script src="https://<ns>.firebaseio.com/.lp?…">` — and our CSP's
 * `script-src` refuses it, so in this app it can never connect. The SDK picks
 * it more often than it looks: every WebSocket it opens first sets
 * `firebase:previous_websocket_failure`, which only a socket that has answered
 * twice clears, and while the flag is set (or storage throws) every connection
 * starts with long-polling. Long-polling upgrades to a WebSocket only once it
 * has connected, so under our CSP it never upgrades and the flag never clears.
 * One socket that died young — iOS closes a backgrounded page's sockets, say
 * while its user is in WhatsApp sharing the link — left that browser
 * permanently "offline": its creates and joins pending forever, and every link
 * it handed out naming a session that was never written.
 *
 * Admitting the fallback instead would mean running script from
 * *.firebaseio.com in our origin. A network that blocks WebSockets loses
 * nothing: the CSP already denied it the fallback.
 */
function createDatabase(app: FirebaseApp, config: AppConfig): Database {
  Sentry.setTag("rtdb_ws_history", readWebSocketHistory());
  // A process-wide switch, and it must precede the first connection, which the
  // composition root guarantees: nothing has a Database handle yet.
  forceWebSockets();
  const db = getDatabase(app);
  if (config.rtdbEmulatorHost !== null) {
    const { host, port } = parseEmulatorHost(config.rtdbEmulatorHost);
    connectDatabaseEmulator(db, host, port);
  }
  return db;
}

export function createFirebaseServices(config: AppConfig): FirebaseServices {
  const app = createApp(config);

  // Ordered on purpose, not an object literal. Properties evaluate in source
  // order, so the previous literal built the Database handle before App Check
  // was registered on the app — backwards, whatever the SDK does about it
  // internally. Attestation is registered and in flight before any service
  // handle exists.
  const appCheck = createAppCheck(app, config);
  const appCheckReady = primeAppCheck(appCheck);

  return {
    app,
    appCheck,
    appCheckReady,
    db: createDatabase(app, config),
    auth: createAuth(app),
  };
}

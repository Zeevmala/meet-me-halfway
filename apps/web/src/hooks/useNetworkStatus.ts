import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import * as Sentry from "@sentry/react";
import { useFirebase } from "./useFirebase";

/**
 * What the connectivity banner has to say: three answers, not two.
 *
 * This was one `isOnline` boolean, so a browser with a working network that
 * could not reach the database was told "You are offline", over a map whose
 * tiles were still loading. The two need different words, and only one of
 * them is the device's to fix.
 */
export type Connectivity =
  /** Network up, and the database reachable or within its grace period. */
  | "online"
  /** The browser reports no network. */
  | "offline"
  /** Network up, but the database unreachable for longer than the grace period. */
  | "unreachable";

export interface NetworkStatus {
  /** Browser reports navigator.onLine */
  readonly browserOnline: boolean;
  /** Firebase RTDB WebSocket is connected — raw, before the grace period. */
  readonly firebaseConnected: boolean;
  /** What to tell the user. */
  readonly connectivity: Connectivity;
}

// Grace period before trusting a Firebase `.info/connected = false` signal.
// iOS Safari fires brief disconnects on App Check token refresh, page
// resume from background, and mobile-data hand-off — none of which the
// user should see as a lost connection.
const FIREBASE_OFFLINE_GRACE_MS = 6_000;

/**
 * Tracks connectivity via two signals:
 * 1. Browser `navigator.onLine` + online/offline events (definitive)
 * 2. Firebase RTDB `.info/connected` (noisy — debounced 6s before
 *    being trusted, so transient WebSocket flake doesn't flash a
 *    misleading banner).
 */
export function useNetworkStatus(): NetworkStatus {
  const { db, appCheckReady } = useFirebase();
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  // Optimistic: assume connected until Firebase `.info/connected` fires.
  const [firebaseConnected, setFirebaseConnected] = useState(true);
  // Debounced: only true after Firebase has been disconnected for > grace period.
  const [firebaseStableOffline, setFirebaseStableOffline] = useState(false);
  const unsubRef = useRef<Unsubscribe | null>(null);
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOnline = useCallback(() => setBrowserOnline(true), []);
  const handleOffline = useCallback(() => setBrowserOnline(false), []);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Waits for attestation, though not because this listener opens the
    // socket — it does not. `.info/*` is answered from the SDK's own local
    // tree; the socket opens on the session handshake's first read or write,
    // which awaits `appCheckReady` itself. Gating this the same way starts the
    // grace period below when the connection attempt does. Attached earlier,
    // `.info/connected` reads false at once, and a slow reCAPTCHA — up to its
    // whole budget — would be counted against a socket nobody had tried to
    // open yet.
    //
    // `appCheckReady` always settles and never rejects, so a blocked or slow
    // reCAPTCHA delays this by at most the attestation budget.
    let cancelled = false;
    void appCheckReady.then(() => {
      if (cancelled) return;
      const connectedRef = ref(db, ".info/connected");
      unsubRef.current = onValue(connectedRef, (snap) => {
        const connected = snap.val() === true;
        setFirebaseConnected(connected);
        if (connected) {
          if (offlineTimerRef.current) {
            clearTimeout(offlineTimerRef.current);
            offlineTimerRef.current = null;
          }
          setFirebaseStableOffline(false);
        } else if (!offlineTimerRef.current) {
          offlineTimerRef.current = setTimeout(() => {
            offlineTimerRef.current = null;
            setFirebaseStableOffline(true);
          }, FIREBASE_OFFLINE_GRACE_MS);
        }
      });
    });

    return () => {
      // Guards an unmount that lands while attestation is still in flight —
      // without it the `.then` above would attach a listener to a dead hook
      // and leak it, since cleanup has already run by then.
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current);
        offlineTimerRef.current = null;
      }
    };
  }, [db, appCheckReady, handleOnline, handleOffline]);

  const connectivity: Connectivity = !browserOnline
    ? "offline"
    : firebaseStableOffline
      ? "unreachable"
      : "online";

  // A browser with a network that cannot reach the database is the state
  // nothing reported: every read and write it makes waits, none of them fails.
  // Once per page — it persists, and the first report says what the rest
  // would. The `appcheck_outcome` and `rtdb_ws_history` tags ride along.
  const reportedUnreachableRef = useRef(false);
  useEffect(() => {
    if (connectivity !== "unreachable" || reportedUnreachableRef.current) {
      return;
    }
    reportedUnreachableRef.current = true;
    Sentry.captureMessage("rtdb_unreachable", { level: "warning" });
  }, [connectivity]);

  return { browserOnline, firebaseConnected, connectivity };
}

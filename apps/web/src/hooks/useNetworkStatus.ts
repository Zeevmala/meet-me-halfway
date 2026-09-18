import { useCallback, useEffect, useRef, useState } from "react";
import { onValue, ref } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { useFirebase } from "./useFirebase";

export interface NetworkStatus {
  /** Browser reports navigator.onLine */
  browserOnline: boolean;
  /** Firebase RTDB WebSocket is connected */
  firebaseConnected: boolean;
  /** Combined: both browser and Firebase are online */
  isOnline: boolean;
}

// Grace period before trusting a Firebase `.info/connected = false` signal.
// iOS Safari fires brief disconnects on App Check token refresh, page
// resume from background, and mobile-data hand-off — none of which the
// user should see as "offline".
const FIREBASE_OFFLINE_GRACE_MS = 6_000;

/**
 * Tracks network connectivity via two signals:
 * 1. Browser `navigator.onLine` + online/offline events (definitive)
 * 2. Firebase RTDB `.info/connected` (noisy — debounced 6s before
 *    being trusted, so transient WebSocket flake doesn't flash a
 *    misleading "offline" banner).
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

    // `getDatabase` does not connect; RTDB dials lazily on its first
    // subscription. This listener is therefore what opens the socket — the
    // earliest RTDB touch in the whole app, mounted before any session exists.
    //
    // RTDB attaches the App Check token when it establishes that socket, so
    // subscribing before the first token is minted leaves the connection
    // unattested for its lifetime. That is the race that left 89% of requests
    // unverified while attestation itself was working.
    //
    // `appCheckReady` always settles and never rejects, so a blocked or slow
    // reCAPTCHA delays this by at most the attestation budget and then
    // proceeds unattested — degrade, never block. The offline banner this
    // feeds already waits FIREBASE_OFFLINE_GRACE_MS before it will say
    // anything, so the delay is not observable.
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

  return {
    browserOnline,
    firebaseConnected,
    isOnline: browserOnline && !firebaseStableOffline,
  };
}

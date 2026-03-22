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

/**
 * Tracks network connectivity via two signals:
 * 1. Browser `navigator.onLine` + online/offline events
 * 2. Firebase RTDB `.info/connected` (actual WebSocket status)
 */
export function useNetworkStatus(): NetworkStatus {
  const { db } = useFirebase();
  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [firebaseConnected, setFirebaseConnected] = useState(true);
  const unsubRef = useRef<Unsubscribe | null>(null);

  const handleOnline = useCallback(() => setBrowserOnline(true), []);
  const handleOffline = useCallback(() => setBrowserOnline(false), []);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Firebase RTDB connection status
    const connectedRef = ref(db, ".info/connected");
    unsubRef.current = onValue(connectedRef, (snap) => {
      setFirebaseConnected(snap.val() === true);
    });

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [db, handleOnline, handleOffline]);

  return {
    browserOnline,
    firebaseConnected,
    isOnline: browserOnline && firebaseConnected,
  };
}

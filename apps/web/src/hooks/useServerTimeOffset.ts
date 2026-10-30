import { useEffect, useState } from "react";
import { onValue, ref } from "firebase/database";
import type { Unsubscribe } from "firebase/database";
import { useFirebase } from "./useFirebase";

/**
 * The server's clock minus this device's, in ms, as RTDB measures it on each
 * connection (`.info/serverTimeOffset`); `0` until it has.
 *
 * Peers' `lastSeen` is stamped by the server, so liveness has to judge it
 * against server time. Device clocks run minutes off on some phones: measured
 * against one, a fresh peer looked stale on a slow phone and a departed one
 * looked live on a fast one.
 *
 * Gated on `appCheckReady` like `useNetworkStatus`, and for the same reason:
 * a subscription is what opens the RTDB socket, and one opened before the
 * first App Check token is unattested for its lifetime.
 */
export function useServerTimeOffset(): number {
  const { db, appCheckReady } = useFirebase();
  const [offsetMs, setOffsetMs] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: Unsubscribe | null = null;
    void appCheckReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
        const value: unknown = snap.val();
        setOffsetMs(
          typeof value === "number" && Number.isFinite(value) ? value : 0,
        );
      });
    });

    return () => {
      // An unmount while attestation is still pending must not leave the
      // `.then` above to attach a listener nobody will remove.
      cancelled = true;
      unsubscribe?.();
    };
  }, [db, appCheckReady]);

  return offsetMs;
}

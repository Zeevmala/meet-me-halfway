import { useEffect } from "react";

/**
 * Keep the screen awake while `active`.
 *
 * A web page has no background location: when the screen locks, the browser
 * suspends `watchPosition`, the presence heartbeat stops, and thirty seconds
 * later everyone else sees this participant as stale — in the middle of the
 * trip the app exists for. The Screen Wake Lock API is the one lever a page
 * has, so a live session holds it.
 *
 * The browser releases the lock whenever the page is hidden, and never gives
 * it back by itself, so it is requested again each time the page returns to
 * view. A refusal (battery saver, no support) is not an error: the session
 * works, the screen just dims on its usual timer.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (!("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      if (sentinel !== null && !sentinel.released) return;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          // Granted after the effect ended: hand it straight back.
          if (cancelled) {
            void lock.release().catch(() => {});
            return;
          }
          sentinel = lock;
        })
        .catch(() => {
          /* refused — battery saver, or the page lost visibility meanwhile */
        });
    };

    acquire();
    document.addEventListener("visibilitychange", acquire);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      if (sentinel !== null) void sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}

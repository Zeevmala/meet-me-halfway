/**
 * Reload when a lazily imported chunk has gone.
 *
 * Every deploy replaces the hashed chunks, and the service worker deletes the
 * cache that held the old ones as it takes over. A tab still running the old
 * bundle then 404s on its next lazy import — the page itself, or the venue
 * list — and the error boundary showed "Something went wrong" over a session
 * that was fine. Vite reports the failure as `vite:preloadError`; a reload
 * fetches the new bundle.
 *
 * At most once a minute: a chunk that is genuinely missing has to surface as
 * the error it is, not reload the page forever. Without session storage there
 * is no way to tell the two apart, so the error surfaces.
 */
const STAMP_KEY = "mmh:stale-chunk-reload";

export const STALE_CHUNK_RELOAD_INTERVAL_MS = 60_000;

/** Install the handler on `target`; returns its removal. */
export function reloadOnStaleChunk(target: Window): () => void {
  // Once this page has asked for its reload, every later failure in it comes
  // from the same deploy (a chunk's stylesheet fails, then its script), and
  // the page is on its way out. Surfacing one put the error screen up for as
  // long as the reload took.
  let reloading = false;
  const onPreloadError = (event: Event): void => {
    if (!reloading) {
      try {
        const last = Number(target.sessionStorage.getItem(STAMP_KEY)) || 0;
        if (Date.now() - last < STALE_CHUNK_RELOAD_INTERVAL_MS) return;
        target.sessionStorage.setItem(STAMP_KEY, String(Date.now()));
      } catch {
        return;
      }
      reloading = true;
      target.location.reload();
    }
    // Vite throws the import error unless the event is cancelled.
    event.preventDefault();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

/**
 * Wrap a lazy import so that one the reload cancelled waits for the reload.
 *
 * A cancelled `vite:preloadError` makes Vite resolve the import to
 * `undefined` instead of rejecting it, and `React.lazy` reads `.default` off
 * that: a TypeError, which put the error screen up, and sent Sentry a report,
 * in every tab a deploy reloaded. Never settling keeps the Suspense fallback
 * up until the reload replaces the page. An import that failed without being
 * cancelled still rejects, and reaches the error boundary as itself.
 *
 *   const Page = lazy(pendingWhileReloading(() => import("./Page")));
 */
export function pendingWhileReloading<T>(
  load: () => Promise<T>,
): () => Promise<T> {
  return () =>
    load().then((loaded: T | undefined) => loaded ?? new Promise<T>(() => {}));
}

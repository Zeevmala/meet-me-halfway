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
  const onPreloadError = (event: Event): void => {
    try {
      const last = Number(target.sessionStorage.getItem(STAMP_KEY)) || 0;
      if (Date.now() - last < STALE_CHUNK_RELOAD_INTERVAL_MS) return;
      target.sessionStorage.setItem(STAMP_KEY, String(Date.now()));
    } catch {
      return;
    }
    // Vite throws the import error unless the event is cancelled.
    event.preventDefault();
    target.location.reload();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

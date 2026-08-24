/**
 * Side-effect module: PWA service worker lifecycle, split by build mode.
 *
 * In production the SW is registered normally. In development it is actively
 * torn down, because the cache key in `public/sw.js` is `mmh-__BUILD_HASH__`
 * and the placeholder is only substituted by the `swCacheBust` Vite plugin at
 * build time (`closeBundle`). Under `vite dev` the key is therefore a literal
 * constant, so the shell cached on one run is served to every later run — even
 * across dependency changes. The result is one page mixing module URLs from two
 * Vite optimizer generations, which surfaces as "Invalid hook call ... more
 * than one copy of React" and reads exactly like a dependency regression.
 *
 * The dev teardown is also a repair path: a stale SW registered by an earlier
 * build keeps controlling localhost until something unregisters it, so this
 * runs on every dev load, not just the first.
 */

/** Caches created by `public/sw.js`. Scoped so we never touch unrelated caches. */
const CACHE_PREFIX = "mmh-";

async function unregisterInDev(): Promise<void> {
  // A controller means this page was served by the SW — its module graph may
  // already be stale, so reload once the SW and its caches are gone.
  const wasControlled = navigator.serviceWorker.controller !== null;

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));

  if ("caches" in self) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .map((k) => caches.delete(k)),
    );
  }

  if (wasControlled) {
    console.info("[sw] stale dev service worker removed — reloading");
    // Reload is loop-safe: after unregistering there is no controller, so the
    // next load takes the `wasControlled === false` path.
    location.reload();
  }
}

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.warn("[sw] registration failed:", err));
    });
  } else {
    void unregisterInDev().catch((err) =>
      console.warn("[sw] dev teardown failed:", err),
    );
  }
}

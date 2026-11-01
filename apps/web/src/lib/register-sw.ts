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

/**
 * Production: register, and make sure a deploy actually reaches open tabs.
 *
 * `sw.js` takes over open tabs the moment a new version activates and deletes
 * the cache that held the previous bundle. A tab left running that bundle has
 * nothing to fall back on — its next lazy import 404s — and it keeps writing
 * whatever schema it was built for, which is what a contract-step rules
 * release refuses. So a takeover reloads the page.
 *
 * The browser looks for a new worker only on navigation, which a single-page
 * tab left open for hours never makes, so the check also runs each time the
 * tab comes back into view — the moment a reload costs the least.
 */
function registerInProd(): void {
  // The first worker claiming an uncontrolled page is an install, not an
  // update: reloading then would only repeat a load that just happened.
  let controlled = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState !== "visible") return;
          registration
            .update()
            .catch((err) => console.warn("[sw] update check failed:", err));
        });
      })
      .catch((err) => console.warn("[sw] registration failed:", err));
  });
}

if ("serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    registerInProd();
  } else {
    void unregisterInDev().catch((err) =>
      console.warn("[sw] dev teardown failed:", err),
    );
  }
}

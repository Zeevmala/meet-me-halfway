const CACHE_VERSION = "mmh-__BUILD_HASH__";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

const CACHE_PREFIX = "mmh-";

const SHELL_URLS = ["/", "/index.html"];

// The `swCacheBust` plugin in vite.config.ts substitutes the hash at build time
// only, so a surviving placeholder means this file is being served straight out
// of `public/` by `vite dev`. A dev service worker is actively harmful there:
// the cache key never changes, so it pins one Vite optimizer generation and
// replays it across server restarts and dependency bumps — which surfaces as
// "Invalid hook call ... more than one copy of React" and reads exactly like a
// dependency regression. Under dev this worker removes itself instead.
//
// The marker is split because swCacheBust substitutes with String.replace and a
// string pattern, which rewrites only the FIRST occurrence — a second literal
// would survive the build and leave production stuck in the unbuilt branch.
const IS_UNBUILT = CACHE_VERSION.endsWith("__BUILD" + "_HASH__");

// ── Install: pre-cache app shell ──
self.addEventListener("install", (event) => {
  if (IS_UNBUILT) {
    self.skipWaiting();
    return;
  }
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches + enable navigation preload ──
self.addEventListener("activate", (event) => {
  // Dev: self-destruct. This is the repair path for a worker installed by an
  // earlier build — the browser re-fetches and byte-compares sw.js on navigation
  // without routing that request through the worker, so this still runs when
  // every other response is being served from the stale cache.
  if (IS_UNBUILT) {
    event.waitUntil(selfDestruct());
    return;
  }

  event.waitUntil(
    Promise.all([
      // Clean old caches
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.startsWith(CACHE_VERSION))
            .map((k) => caches.delete(k))
        )
      ),
      // Enable navigation preload if supported — starts fetch in parallel
      // with SW boot, eliminating the SW startup latency penalty
      self.registration.navigationPreload?.enable().catch(() => {}),
    ])
  );
  self.clients.claim();
});

// ── Fetch: strategy per request type ──
self.addEventListener("fetch", (event) => {
  if (IS_UNBUILT) return; // dev: never intercept, let Vite serve every request

  const { request } = event;
  const url = new URL(request.url);

  // Only cache GET requests — Cache API does not support POST
  if (request.method !== "GET") return;

  // External APIs (Mapbox, Firebase, Google) — never intercept
  // SW interception changes request mode and breaks CORS preflight
  if (url.origin !== self.location.origin) return;

  // Navigation requests (index.html) — network-first with preload + timeout
  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithPreload(event));
    return;
  }

  // Hashed static assets (JS/CSS) — cache-first (hash in filename = immutable)
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

/** Dev only: drop every cache this worker owns, then remove the registration. */
async function selfDestruct() {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith(CACHE_PREFIX)).map((k) => caches.delete(k))
  );
  await self.registration.unregister();

  // Controlled tabs keep running the stale module graph until they navigate.
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.navigate(client.url).catch(() => {});
  }
}

// ── Strategies ──

/** Network-first with 3s timeout for navigation. Uses preload response if available. */
async function networkFirstWithPreload(event) {
  const cached = await caches.match(event.request);

  try {
    // Race network (or preload) against a 3s timeout
    const networkPromise = event.preloadResponse
      ? event.preloadResponse.then((r) => r || fetch(event.request))
      : fetch(event.request);

    const response = await Promise.race([
      networkPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), 3000)
      ),
    ]);

    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(event.request, response.clone());
    }
    return response;
  } catch {
    // Network failed or timed out — serve cached shell
    return cached || caches.match("/index.html");
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.mode === "navigate") {
      return caches.match("/index.html");
    }
    return new Response("Offline", { status: 503 });
  }
}

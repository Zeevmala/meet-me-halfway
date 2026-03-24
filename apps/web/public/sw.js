const CACHE_VERSION = "mmh-v5";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;

const SHELL_URLS = ["/", "/index.html"];

// ── Install: pre-cache app shell ──
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ──
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: strategy per request type ──
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only cache GET requests — Cache API does not support POST
  if (request.method !== "GET") return;

  // External APIs (Mapbox, Firebase, Google) — never intercept
  // SW interception changes request mode and breaks CORS preflight
  if (url.origin !== self.location.origin) return;

  // Navigation requests (index.html) — network-first so deploys take effect
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // Hashed static assets (JS/CSS) — cache-first (hash in filename = immutable)
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Strategies ──

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
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

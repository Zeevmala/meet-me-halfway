const CACHE_VERSION = "mmh-v2";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;
const API_CACHE = `${CACHE_VERSION}-api`;

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

  // API mutations (POST/PUT/DELETE) — network only, never cache
  if (url.pathname.startsWith("/api/") && request.method !== "GET") {
    return;
  }

  // API GET requests — network-first with 3s timeout, fallback to cache
  if (url.pathname.startsWith("/api/") && request.method === "GET") {
    event.respondWith(networkFirstWithTimeout(request, API_CACHE, 3000));
    return;
  }

  // Mapbox tiles — stale-while-revalidate
  if (url.hostname.includes("mapbox.com") || url.hostname.includes("mapbox.cn")) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE));
    return;
  }

  // Firebase WebSocket / long-poll — never intercept
  if (url.hostname.includes("firebaseio.com") || url.hostname.includes("googleapis.com")) {
    return;
  }

  // App shell + static assets — cache-first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Strategies ──

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
    // Offline fallback for navigation requests
    if (request.mode === "navigate") {
      return caches.match("/index.html");
    }
    return new Response("Offline", { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}

async function networkFirstWithTimeout(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs)
      ),
    ]);

    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

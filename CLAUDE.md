# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Meet Me Halfway** — a client-side PWA that computes a live midpoint between two people and shows driving routes to the meeting point. Zero backend. Fully static, deployable to Firebase Hosting / Vercel / Netlify.

## Architecture

- **PWA:** React 18 + Vite + Mapbox GL JS 3.x + Tailwind CSS
- **Auth:** Firebase Anonymous Auth — `signInAnonymously()` on app init, UID as participant key
- **App Check:** Firebase App Check with reCAPTCHA Enterprise — client attestation for RTDB
- **Real-time:** Firebase Realtime Database (peer-to-peer location sync, auth-enforced rules)
- **Routing:** Mapbox Directions API (client-side, 3s debounced)
- **Midpoint:** Spherical great-circle formula (client-side, no server)
- **i18n:** i18next with en/he/ar and full RTL support

No backend, no database server, no Docker, no Python.

## Project Structure

```
meet-me-halfway/
├── apps/web/                  # The entire app
│   ├── src/
│   │   ├── features/live-midpoint/    # Core feature
│   │   │   ├── LiveMidpointPage.tsx   # Page orchestrator
│   │   │   ├── components/            # LiveMap, markers, cards, badge
│   │   │   ├── hooks/                 # useLiveGeolocation, useLiveSession, useDirections
│   │   │   ├── lib/                   # geo-math, session-code, nav-links
│   │   │   └── styles/               # live-midpoint.css (dark theme)
│   │   ├── components/                # ErrorBoundary, LanguageSwitcher
│   │   ├── hooks/                     # useFirebase, useAuth, useNetworkStatus
│   │   ├── lib/                       # env.ts, i18n.ts
│   │   ├── i18n/                      # en.json, he.json, ar.json
│   │   ├── main.tsx                   # Entry point
│   │   └── index.css
│   ├── public/                        # PWA manifest, service worker, icons
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── tailwind.config.ts
├── infra/
│   ├── database.rules.json            # Firebase RTDB security rules
│   └── firebase.json                  # Firebase Hosting config
├── .github/workflows/web.yml          # CI: lint + typecheck + test + build
├── .env.example                       # 6 VITE_* env vars
└── README.md
```

## Core Flow

1. **Auth:** App init → `signInAnonymously()` with retry (3 attempts, exponential backoff) → UID assigned (persisted across sessions)
2. **Creator** opens `/` → geolocation prompt → 6-char session code generated → URL becomes `/?code=XXXXX`
3. **Joiner** opens `/?code=XXXXX` → geolocation prompt → joins as participant B
4. Both locations stream to Firebase RTDB at `/sessions/{code}/participants/{uid}`
5. Client computes spherical midpoint + fetches Mapbox driving routes
6. Dark map shows colored polylines (green A → midpoint, blue B → midpoint)
7. Cards show distances, drive times, Waze/Google Maps navigation links

## Environment Variables

```
VITE_MAPBOX_TOKEN        # Mapbox public token (pk.*)
VITE_FIREBASE_API_KEY    # Firebase Web API key
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_DATABASE_URL
VITE_FIREBASE_PROJECT_ID
VITE_RECAPTCHA_SITE_KEY  # reCAPTCHA Enterprise site key for App Check
VITE_GOOGLE_PLACES_API_KEY  # Optional — venue search disabled if not set
```

## License

MIT — see [LICENSE](LICENSE).

## Dev Commands

```bash
cd apps/web
npm install
npm run dev          # Vite dev server at localhost:5173
npm run tsc          # TypeScript check (tsc --noEmit)
npm run build        # Production build
npx vitest run       # Run all 147 tests
npx vitest --coverage # Coverage report
```

## Firebase RTDB Schema

```
/sessions/{6charCode}/
  created: number (timestamp)
  creatorUid: string (Firebase auth uid)
  joinerUid: string (Firebase auth uid)
  participants/{uid}: { lat, lng, accuracy, ts }
```

Security rules: `/infra/database.rules.json` — auth required for all reads, uid-scoped writes, write-once session metadata, numeric range validation.

## i18n

Locales: `en`, `he` (Hebrew), `ar` (Arabic). Full RTL support via CSS logical properties. Namespaces: `app`, `live`, `common`.

## v1 MVP Remaining Tasks

### P0 — Core Real-time Flow (Complete)
- [x] Live location streaming via RTDB — both participants push coords via `watchPosition`
- [x] Real-time geodesic midpoint calculation and map display (update on every location change)
- [x] RTDB write throttle (max 1 per 3s, leading+trailing edge)
- [x] GPS accuracy circles (GeoJSON fill layers, spherical direct formula)
- [x] Stale partner detection (30s threshold, dimmed marker + warning)
- [x] Smooth map transitions (50m jitter suppression, easeTo/fitBounds)
- [x] 89 unit tests (geo-math, session-code, useAuth, useLiveSession throttle/stale, accuracy circles)

### P1 — Destination Features (Complete)
- [x] Venue/POI search around midpoint (Google Places API New, optional key, 5s stability, 100m cache)
- [x] Venue ranking formula: 0.40 rating + 0.30 proximity + 0.20 popularity + 0.10 open_now (14 tests)
- [x] VenueListCard with loading shimmer, ranked list, tap-to-select
- [x] VenueMarker on map (gray dot / green selected) with truncated labels
- [x] Directions to venue or midpoint (Mapbox Directions API, dual routing, 200m movement threshold)
- [x] Driving/walking profile toggle in MidpointCard
- [x] Nav links (Waze/Google Maps) point to selected venue or midpoint
- [x] Bottom panel layout: VenueListCard stacked above MidpointCard
- [x] i18n: all venue/profile strings in en/he/ar
- [x] 103 unit tests (89 existing + 14 venue ranking)

### P2 — Robustness (Complete)
- [x] Error handling: GPS denied/unavailable/timeout with retry UI, offline/reconnect banner, 24h session expiry, stale location timeout
- [x] `useNetworkStatus` hook — Firebase RTDB `.info/connected` tracking
- [x] `SessionErrorCode` typed union — replaces fragile error string matching
- [x] Auth retry with exponential backoff (1s, 2s, 4s) on `signInAnonymously()` failure
- [x] App Check made optional — graceful degradation when reCAPTCHA unavailable
- [x] Mapbox GL pre-bundling fix for Vite dev server compatibility
- [x] CI test job added to GitHub Actions workflow
- [x] 147 unit + integration tests (GPS, directions, venue search, page lifecycle, session expiry, auth retry)

### P3 — Future (v2)
- [ ] E2E tests (Playwright) for full session lifecycle
- [ ] WhatsApp bot for session creation and invites

## Code Style

- TypeScript strict mode, ES modules
- Functional components + hooks (no class components)
- Tailwind + custom CSS for dark glass-morphism theme
- `const` over `let`, never `var`
- CRS: WGS84 (EPSG:4326) everywhere, GeoJSON `[lng, lat]` order

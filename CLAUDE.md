# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Meet Me Halfway** — a client-side PWA that computes a live midpoint between up to 5 participants and shows driving routes to the meeting point. Zero backend. Fully static, deployable to Firebase Hosting / Vercel / Netlify.

## Dev Commands

All commands run from `apps/web/`:

```bash
cd apps/web
npm install
npm run dev              # Vite dev server at localhost:5173
npm run build            # Production build → dist/
npm run tsc              # TypeScript check (strict, noUnusedLocals/Parameters)
npm test                 # vitest run (all tests)
npm run test:coverage    # vitest with coverage
npx vitest run src/features/live-midpoint/lib/geo-math.test.ts   # single test file
npx vitest run -t "midpoint"                                      # tests matching name pattern
```

**CI pipeline** (`.github/workflows/web.yml`): eslint → prettier check → tsc → vitest → vite build. All must pass. ESLint runs with `--max-warnings=0`.

## Architecture

- **Single-page React 18 app** — one route (`/`), one page component (`LiveMidpointPage`), no router
- **Vite 6** with manual chunks: react, firebase, mapbox, i18n
- **Firebase Anonymous Auth** — `signInAnonymously()` on app init, UID as participant key
- **Firebase App Check** — reCAPTCHA Enterprise attestation (optional, graceful degradation)
- **Firebase Realtime Database** — peer-to-peer location sync, auth-enforced security rules in `infra/database.rules.json`
- **Mapbox GL JS 3.x** — dark-v11 basemap, pre-bundled via `optimizeDeps.include`
- **Mapbox Directions API** — client-side N-participant routing (all participants to midpoint/venue), 3s debounced
- **Google Places API (New)** — venue search around midpoint (optional, disabled if `VITE_GOOGLE_PLACES_API_KEY` not set)
- **Midpoint** — geographic centroid via Cartesian mean on unit sphere (supports 2–5 points), computed client-side
- **Participant model** — up to 5 participants per session, indexed 0–4 (creator = 0), each with a distinct color
- **i18next** — en/he with full RTL support via CSS logical properties

No backend, no database server, no Docker, no Python.

## Core Flow

1. App init → `signInAnonymously()` with retry (3 attempts, exponential backoff)
2. **Creator** opens `/` → geolocation prompt → 6-char session code → URL becomes `/?code=XXXXX`
3. **Joiners** (up to 4) open `/?code=XXXXX` → each registers in `participantUids/{uid}` and gets assigned an index (1–4)
4. All participant locations stream to Firebase RTDB at `/sessions/{code}/participants/{uid}` (throttled 1 write/3s)
5. Client computes geographic centroid of all positions + fetches Mapbox driving routes for each participant
6. Optional venue search around midpoint (Google Places, ranked by rating/proximity/popularity/open_now)

## Key Source Layout

```
apps/web/src/
├── main.tsx                           # Entry: env validation → Firebase init → React render
├── features/live-midpoint/
│   ├── LiveMidpointPage.tsx           # Page orchestrator (auth gate → inner page)
│   ├── components/                    # LiveMap, SessionBadge, WaitingCard, MidpointCard, VenueListCard
│   ├── hooks/
│   │   ├── useLiveGeolocation.ts      # watchPosition wrapper with error handling
│   │   ├── useLiveSession.ts          # RTDB session CRUD + N-participant location sync
│   │   ├── useDirections.ts           # Mapbox Directions for N participants with debounce + movement threshold
│   │   └── useVenueSearch.ts          # Google Places with stability delay + distance cache
│   └── lib/
│       ├── geo-math.ts                # sphericalMidpoint, geographicCentroid, haversineDistance, accuracyCircleGeoJSON
│       ├── participant-config.ts      # MAX_PARTICIPANTS, ParticipantIndex type, PARTICIPANT_COLORS (5-color palette)
│       ├── session-code.ts            # 6-char code generation/validation
│       ├── venue-ranking.ts           # Weighted scoring: 0.40 rating + 0.30 proximity + 0.20 popularity + 0.10 open_now
│       ├── places-api.ts              # Google Places API (New) client
│       └── nav-links.ts              # Waze/Google Maps deep link generators
├── hooks/
│   ├── useAuth.ts                     # Firebase Anonymous Auth with retry
│   ├── useFirebase.ts                 # Firebase app/db singleton init
│   └── useNetworkStatus.ts            # Firebase RTDB .info/connected tracking
├── lib/
│   ├── env.ts                         # VITE_* env var validation (throws on missing required vars)
│   └── i18n.ts                        # i18next config
└── i18n/                              # en.json, he.json — namespaces: app, live, common
```

Tests are co-located as `*.test.ts` / `*.test.tsx` next to source files. Test environment: jsdom with vitest globals.

## Firebase RTDB Schema

```
/sessions/{6charCode}/
  created: number (timestamp)
  creatorUid: string (write-once, must match auth.uid)
  participantUids/{uid}: true (write-once per uid, up to 5 participants)
  participants/{uid}: { lat, lng, accuracy, ts }  (uid-scoped writes only)
```

Security rules enforce: auth required for all reads, uid-scoped writes, write-once session metadata, numeric range validation for lat/lng, no extra fields (`$other: false`). Participant count (max 5) checked client-side since Firebase RTDB rules lack `numChildren()`.

## Code Conventions

- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`)
- Functional components + hooks only
- Tailwind + custom CSS dark glass-morphism theme (`live-midpoint.css`)
- `const` over `let`, never `var`
- CRS: WGS84 (EPSG:4326) everywhere, GeoJSON `[lng, lat]` order
- `LatLng` type uses `{ lat, lng }` (not arrays) for internal representation
- Session error codes use typed union `SessionErrorCode` (not string matching)
- i18n keys mapped via typed records (e.g., `SESSION_ERROR_I18N`)
- Participant indexing via `ParticipantIndex = 0 | 1 | 2 | 3 | 4` (creator = 0, joiners sorted by UID)
- 5-color palette: green (#00d4aa), blue (#6c8cff), orange (#ff9f43), purple (#a855f7), pink (#f472b6) — CSS classes `--p0` through `--p4`

## Environment Variables

Required: `VITE_MAPBOX_TOKEN`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_RECAPTCHA_SITE_KEY`.
Optional: `VITE_GOOGLE_PLACES_API_KEY` (venue search disabled if not set).

See `.env.example` at project root. App validates required vars at startup and throws if missing.

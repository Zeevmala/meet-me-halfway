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

**CI pipeline** (`.github/workflows/web.yml`): `lint` (npm audit → eslint → prettier check) and `typecheck` run in parallel → `test` (vitest) → `build` → `lighthouse` + `e2e` → `deploy` (main only). All must pass. ESLint runs with `--max-warnings=0`, so `react-hooks/exhaustive-deps` and the custom RTL `no-restricted-syntax` rule — both `warn` — fail CI.

## Architecture

- **Single-page React 19 app** — one route (`/`), one page component (`LiveMidpointPage`), no router
- **Vite 6** with manual chunks: react, firebase, mapbox, i18n
- **Firebase Anonymous Auth** — explicit `initializeAuth` singleton in `useFirebase.ts` with persistence fallback chain (IndexedDB → localStorage → in-memory) so strict-privacy browsers still sign in; `signInAnonymously()` on app init, UID as participant key. Failures classify to typed `AuthErrorCode` (network retried 3×, storage-blocked terminal). Tradeoff: under in-memory persistence a reload mints a new anonymous UID, consuming a fresh write-once `participantUids` slot
- **Firebase App Check** — reCAPTCHA Enterprise attestation (optional, graceful degradation)
- **Firebase Realtime Database** — peer-to-peer location sync, auth-enforced security rules in `infra/database.rules.json`
- **Mapbox GL JS 3.x** — dark-v11 basemap, pre-bundled via `optimizeDeps.include`
- **Mapbox Directions API** — client-side N-participant routing (all participants to midpoint/venue), 3s debounced
- **Google Places API (New)** — venue search around midpoint (optional, disabled if `VITE_GOOGLE_PLACES_API_KEY` not set)
- **Midpoint** — geographic centroid via Cartesian mean on unit sphere (supports 2–5 points), computed client-side
- **Derived pipeline runs as a declared DAG** — `slots → midpoint → venues → destination → routes → frame`, declared in `features/live-midpoint/graph/edges.ts`, executed in topological order by a per-mount runtime exposed through `useSyncExternalStore`. Effectful nodes are `createResource` instances carrying debounce + maxWait, admission control, retry, timeout, a lazy circuit breaker and last-known-good degradation. See `ARCHITECTURE.md`
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
│   ├── graph/                         # the derived pipeline — see ARCHITECTURE.md
│   │   ├── edges.ts                   # EDGES + assertAcyclic (Kahn); TOPO_ORDER drives the runtime
│   │   ├── nodes.ts                   # pure: buildSlotVector, deriveMidpoint, deriveDestination
│   │   ├── policies.ts                # venue + route ResourcePolicy (debounce, admit, identity, breaker)
│   │   ├── ports.ts                   # injected I/O seam (now/schedule/cancel/searchVenues/fetchRoute)
│   │   ├── runtime.ts                 # per-mount runtime, atomic GraphSnapshot, setSources(patch)
│   │   ├── types.ts                   # SlotVector, GraphSources, RouteInfo, TravelProfile
│   │   └── useGraph.ts                # useSyncExternalStore bindings
│   ├── hooks/                         # source adapters — event streams, not graph nodes
│   │   ├── useLiveGeolocation.ts      # watchPosition wrapper with error handling
│   │   └── useLiveSession.ts          # RTDB session CRUD + N-participant location sync
│   └── lib/
│       ├── geo-math.ts                # sphericalMidpoint, geographicCentroid, haversineDistance, accuracyCircleGeoJSON
│       ├── slot-registry.ts           # first-seen-wins uid→ParticipantIndex; slots are stable for the session
│       ├── participant-config.ts      # MAX_PARTICIPANTS, ParticipantIndex type, PARTICIPANT_COLORS (5-color palette)
│       ├── session-code.ts            # 6-char code generation/validation
│       ├── venue-ranking.ts           # Weighted scoring: 0.40 rating + 0.30 proximity + 0.20 popularity + 0.10 open_now
│       ├── places-api.ts              # Google Places API (New) client → Result<PlaceResult[], ResourceError>
│       ├── directions-api.ts          # Mapbox Directions client → Result<RouteInfo | null, ResourceError>
│       └── nav-links.ts              # Waze/Google Maps deep link generators
├── core/dag/                          # framework- and domain-agnostic execution core
│   ├── result.ts                      # Result<T, E> + ok/err
│   ├── errors.ts                      # ResourceError union, isRetryableError, countsAgainstBreaker
│   ├── breaker.ts                     # lazy circuit breaker (no timers — clock-compared)
│   ├── backoff.ts                     # shared exponential backoff with optional jitter
│   └── resource.ts                    # createResource: the one effectful-node combinator
├── hooks/
│   ├── useAuth.ts                     # Anonymous sign-in with retry + typed AuthErrorCode classification
│   ├── useFirebase.ts                 # Firebase app/db/auth/App Check singleton init (persistence fallback chain)
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
- Participant indexing via `ParticipantIndex = 0 | 1 | 2 | 3 | 4` (creator = 0). Slots come from `lib/slot-registry.ts` and are **stable for the session** — first-seen-wins, never renumbered when someone leaves. Anything keyed by slot (routes, accuracy circles, colours, Mapbox layer ids) must agree on that one index space
- Fallible operations return `Result<T, E>` from `core/dag/result.ts` rather than throwing, returning an empty value, or writing a state code
- New effectful work belongs in a `ResourcePolicy` (`graph/policies.ts`), not a bespoke hook with its own debounce and abort handling
- I/O reaches the graph through `graph/ports.ts` so tests inject fakes and a virtual clock instead of mocking modules, globals or timers
- 5-color palette: green (#00d4aa), blue (#6c8cff), orange (#ff9f43), purple (#a855f7), pink (#f472b6) — CSS classes `--p0` through `--p4`

## Environment Variables

Required: `VITE_MAPBOX_TOKEN`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_RECAPTCHA_SITE_KEY`.
Optional: `VITE_GOOGLE_PLACES_API_KEY` (venue search disabled if not set), `VITE_FIREBASE_APP_ID` (required for App Check — without it the attestation token exchange 400s and App Check init is skipped with a warning).

See `.env.example` at project root. App validates required vars at startup and throws if missing.

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
- **Composition root** — `lib/config.ts` is the only module reading `VITE_*` application config; `lib/services.ts` wires Firebase, the API clients and the graph ports once in `main.tsx` and passes them down via `ServicesProvider`. Nothing below that constructs a Firebase handle or reads a credential
- **Firebase Anonymous Auth** — `lib/firebase-factory.ts` builds auth with an explicit persistence fallback chain (IndexedDB → localStorage → in-memory) so strict-privacy browsers still sign in; `signInAnonymously()` on app init, UID as participant key. Failures classify to typed `AuthErrorCode` (network retried 3×, storage-blocked terminal). Tradeoff: under in-memory persistence a reload mints a new anonymous UID. That used to consume a fresh slot permanently; slot claims are now released by absence and `lib/slot-memory.ts` asks for the previous one back, so a reload keeps its slot and colour
- **Firebase App Check** — reCAPTCHA Enterprise attestation (optional, graceful degradation)
- **Firebase Realtime Database** — peer-to-peer location sync, auth-enforced security rules in `infra/database.rules.json`
- **Mapbox GL JS 3.x** — dark-v11 basemap, pre-bundled via `optimizeDeps.include`
- **Mapbox Directions API** — client-side N-participant routing (all participants to midpoint/venue), 3s debounced
- **Google Places API (New)** — venue search around midpoint (optional, disabled if `VITE_GOOGLE_PLACES_API_KEY` not set)
- **Midpoint** — geographic centroid via Cartesian mean on unit sphere (supports 2–5 points), computed client-side
- **Derived pipeline runs as a declared DAG** — `liveness → slots → {presence, midpoint} → phase/venues → destination → routes → frame`, declared in `features/live-midpoint/graph/edges.ts`, executed in topological order by a per-mount runtime exposed through `useSyncExternalStore`. Effectful nodes are `createResource` instances carrying debounce + maxWait, admission control, retry, timeout, a lazy circuit breaker and last-known-good degradation, under a shared concurrency bulkhead (`core/dag/semaphore.ts`). Own location is published by the `presence` node — a write expressed as the same combinator. See `ARCHITECTURE.md`
- **Participant model** — up to 5 participants per session, indexed 0–4 (creator = 0), each with a distinct color
- **i18next** — en/he with full RTL support via CSS logical properties

No backend, no database server, no Docker, no Python.

## Core Flow

1. App init → `signInAnonymously()` with retry (3 attempts, exponential backoff)
2. **Creator** opens `/` → geolocation prompt → 6-char session code → URL becomes `/?code=XXXXX`
3. **Joiners** (up to 4) open `/?code=XXXXX` → each claims a slot under `slots/{0..4}`; the database arbitrates, a loser retries the next candidate, and five slots whose holders are all *present* means a genuine `SESSION_FULL`
4. All participant locations stream to Firebase RTDB at `/sessions/{code}/participants/{slot}` (throttled 1 write/3s by the `presence` node)
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
│   │   ├── nodes.ts                   # pure: deriveLiveness, buildSlotVector, deriveMidpoint, derivePhase, deriveDestination
│   │   ├── policies.ts                # venue + route + presence ResourcePolicy (debounce, admit, identity, breaker)
│   │   ├── ports.ts                   # injected I/O seam (now/schedule/cancel/searchVenues/fetchRoute/writePresence)
│   │   ├── runtime.ts                 # per-mount runtime, atomic GraphSnapshot, setSources(patch)
│   │   ├── types.ts                   # SlotVector, GraphSources, RouteInfo, TravelProfile
│   │   └── useGraph.ts                # useSyncExternalStore bindings
│   ├── hooks/                         # source adapters — event streams, not graph nodes
│   │   ├── useLiveGeolocation.ts      # watchPosition wrapper with error handling
│   │   └── useLiveSession.ts          # RTDB create/join/listen; returns Result, takes an AbortSignal
│   └── lib/
│       ├── geo-math.ts                # sphericalMidpoint, geographicCentroid, haversineDistance, accuracyCircleGeoJSON
│       ├── participant-config.ts      # MAX_PARTICIPANTS, ParticipantIndex type, PARTICIPANT_COLORS (5-color palette)
│       ├── session-code.ts            # 6-char code generation/validation
│       ├── slot-memory.ts             # per-device memo of the slot held in a session
│       ├── venue-ranking.ts           # Weighted scoring: 0.40 rating + 0.30 proximity + 0.20 popularity + 0.10 open_now
│       ├── places-api.ts              # createPlacesClient(key) → Result<PlaceResult[], ResourceError>
│       ├── directions-api.ts          # createDirectionsClient(token) → Result<RouteInfo | null, ResourceError>
│       ├── presence-rtdb.ts           # slot-keyed own-location write + onDisconnect arming, behind the port
│       ├── fit-bounds.ts              # identity-keyed fitBounds jitter guard
│       └── nav-links.ts              # Waze/Google Maps deep link generators
├── core/dag/                          # framework- and domain-agnostic execution core
│   ├── result.ts                      # Result<T, E> + ok/err
│   ├── errors.ts                      # ResourceError union, isRetryableError, countsAgainstBreaker
│   ├── breaker.ts                     # lazy circuit breaker (no timers — clock-compared)
│   ├── backoff.ts                     # shared exponential backoff, jitter + Retry-After floor
│   ├── semaphore.ts                   # FIFO bulkhead bounding total in-flight I/O
│   └── resource.ts                    # createResource: the one effectful-node combinator
├── components/
│   └── ServicesProvider.tsx           # DI boundary; useServices()
├── hooks/
│   ├── useAuth.ts                     # Anonymous sign-in with retry + typed AuthErrorCode classification
│   ├── useFirebase.ts                 # thin read of useServices().firebase
│   └── useNetworkStatus.ts            # Firebase RTDB .info/connected tracking
├── lib/
│   ├── config.ts                      # the ONLY module reading VITE_* app config; validateAppConfig
│   ├── services.ts                    # composition root: createServices(config)
│   ├── firebase-factory.ts            # createFirebaseServices(config) — no module state
│   └── i18n.ts                        # i18next config
└── i18n/                              # en.json, he.json — namespaces: app, live, common
```

Tests are co-located as `*.test.ts` / `*.test.tsx` next to source files. Test environment: jsdom with vitest globals.

Security-rules tests are the exception: they live in `apps/web/rules/`, run in a node environment against the RTDB emulator via `vitest.rules.config.ts`, and are invoked with `npm run test:rules`. Note that `tsconfig.json` currently **excludes** `*.test.ts` from `tsc`, so type errors in test files do not fail `npm run tsc`.

## Firebase RTDB Schema

```
/sessions/{6charCode}/
  created: number (timestamp)
  created: number (write-once, server-stamped; readable even when expired)
  creatorUid: string (write-once, must match auth.uid)
  slots/{0..4}: uid (exactly five keys may ever exist; released by absence)
  participants/{slot}: { uid, lat, lng, accuracy, ts, name }
```

Security rules enforce: auth required for all reads, write-once session metadata, numeric range validation for lat/lng, no extra fields (`$other: false`) — and **the participant cap**.

The cap is a property of the schema, not a client-side check. Exactly five keys are declared under `slots`, each write-once and each validated to equal the writer's `auth.uid`; any other key has no `.write` rule anywhere up the tree and is rejected. `participants/{slot}` is then writable only by whoever holds `slots/{slot}`, which needs no key-pattern matching: since only 0–4 can exist under `slots`, any other participant key resolves to a null holder and is denied for free. Slot 0 is an ordinary slot: pinning it to `creatorUid` made "the creator is green" a server invariant, and made the slot unrecoverable the moment the creator's anonymous UID changed. The creator still gets it, by claiming it before anyone else has the code.

Claiming is arbitrated by the database rather than by a client registry: two clients racing for one index are serialised, and the loser's `set` is rejected with `permission_denied`, so `claimSlot` in `useLiveSession` simply retries the next candidate. `SESSION_FULL` is therefore a fact about the session rather than a guess.

A claim is **held by presence, not by permanence**: `slots/{i}` is writable while it is free *or* while `participants/{i}` does not exist. `onDisconnect` clears that node when a socket drops, so its absence is the database's own evidence the holder is gone. Write-once claims leaked — an anonymous UID that changes between loads (ITP eviction, in-memory persistence) stranded one per reload, and five reloads by one person made the session full for everybody. `claimSlot` tries the slot this device remembers (`lib/slot-memory.ts`) if nobody is in it, then free indices, then vacated ones: free-before-vacated means a live participant between heartbeats is never displaced, and the memo is what returns a reconnecting device to its own slot and colour.

The 24h TTL is likewise the server's. `created` is written with `serverTimestamp()` and validated against the server clock, and it carries its own `.read` so a joiner can tell an absent session from an expired one from a genuinely refused request — all three used to arrive as one `permission_denied` and be reported as "your browser may be blocking storage or attestation".

Rules are tested against the RTDB emulator (see `rules/database.rules.test.ts`), wired into CI as its own job. Run locally from the repo root:

```bash
npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:rules"
```

`firebase-tools` is deliberately not a devDependency — it is 23 MB and `npm ci` runs in every CI job, so it is invoked pinned at the one call site that needs it.

## Code Conventions

- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`)
- Functional components + hooks only
- Tailwind + custom CSS dark glass-morphism theme (`live-midpoint.css`)
- `const` over `let`, never `var`
- CRS: WGS84 (EPSG:4326) everywhere, GeoJSON `[lng, lat]` order
- `LatLng` type uses `{ lat, lng }` (not arrays) for internal representation
- Session error codes use typed union `SessionErrorCode` (not string matching)
- i18n keys mapped via typed records (e.g., `SESSION_ERROR_I18N`)
- Participant indexing via `ParticipantIndex = 0 | 1 | 2 | 3 | 4` (creator = 0). Slots are **claimed from the database** (`sessions/{code}/slots/{i}`) and are stable for the session — never renumbered when someone leaves. Anything keyed by slot (routes, accuracy circles, colours, Mapbox layer ids, the RTDB participant key) must agree on that one index space
- Enforce invariants where they cannot be bypassed. A limit a client checks is a limit a modified client ignores: if a rule can express it, the rule owns it
- Fallible operations return `Result<T, E>` from `core/dag/result.ts` rather than throwing, returning an empty value, or writing a state code. This includes the session handshake: `createSession`/`joinSession` return `Result` and take an `AbortSignal`
- Derived values are derived, not stored. `SessionPhase` and participant staleness are graph nodes, not `useState` — a predicate over a clock must never be driven by a polling interval (mobile browsers throttle `setInterval` to minutes and freeze it under bfcache)
- Anything the graph publishes is referentially stable; do not rebuild it with `.map()` in a render body. Project it with `useMemo` keyed on the snapshot array, or the map re-uploads every route geometry per frame
- New effectful work belongs in a `ResourcePolicy` (`graph/policies.ts`), not a bespoke hook with its own debounce and abort handling
- I/O reaches the graph through `graph/ports.ts` so tests inject fakes and a virtual clock instead of mocking modules, globals or timers. React-tree dependencies arrive through `ServicesProvider` for the same reason
- `import.meta.env.VITE_*` is read in `lib/config.ts` and nowhere else (`DEV`/`PROD`/`MODE` are build flags and stay at their point of use)
- 5-color palette: green (#00d4aa), blue (#6c8cff), orange (#ff9f43), purple (#a855f7), pink (#f472b6) — CSS classes `--p0` through `--p4`

## Environment Variables

Required: `VITE_MAPBOX_TOKEN`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_RECAPTCHA_SITE_KEY` — all six enforced by `validateAppConfig`.
Optional: `VITE_GOOGLE_PLACES_API_KEY` (venue search disabled if not set), `VITE_FIREBASE_APP_ID` (required for App Check — without it the attestation token exchange 400s and App Check init is skipped with a warning).

See `.env.example` at project root. `main.tsx` calls `validateAppConfig` before React renders and throws naming every missing variable at once.

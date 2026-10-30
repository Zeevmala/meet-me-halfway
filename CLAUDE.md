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
npm run build:e2e        # the e2e bundle: --mode e2e, reads .env.e2e (fake keys + RTDB emulator host)
# e2e — from the repo root, under the RTDB emulator (needs Java):
npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:e2e"
```

**CI pipeline** (`.github/workflows/web.yml`): `lint` (npm audit → eslint → prettier check), `typecheck` and `rules` run in parallel; `test` (vitest) follows `lint` and `typecheck`; `build` and `e2e` follow all four, **in parallel**; `lighthouse` follows `build`; `deploy` (main only) follows everything. All must pass. `e2e` deliberately does not depend on `build`: it builds its own `--mode e2e` dist from `apps/web/.env.e2e` and never consumes the `web-dist` artifact, so that edge carries no data — it would only inherit `build`'s Dependabot skip (secrets are withheld from Dependabot PRs), and dependency bumps would again merge with no e2e and no `vite build`, as they did until `#83`. ESLint runs with `--max-warnings=0`, so `react-hooks/exhaustive-deps` and the custom RTL `no-restricted-syntax` rule — both `warn` — fail CI.

**E2E runs the real client against the real rules, under production's headers.** `vite preview` serves the `**` header rule read from `firebase.json` (CSP included), adding only the emulator's origin to `connect-src` in e2e mode; Playwright's global setup loads `infra/database.rules.json` into the emulator; Firebase Auth is answered with unsigned tokens the emulator accepts (`e2e/helpers/mock-firebase.ts`). `e2e/live-session.spec.ts` is the two-device spec: create, join, meet, then assert no CSP violations, Mapbox's stylesheet applied, every marker inside the map and the midpoint marker halfway between the participants. It runs on Chromium only (WebGL in headless Firefox on the runner is unverified). Before this, e2e was mocked HTTP under no CSP and asserted only that `.live-page` rendered — which the error boundary's fallback also satisfies.

**Stop hook** (`.claude/hooks/verify-on-stop.mjs`, registered in `.claude/settings.json`). Before a Claude Code turn may end, the hook diffs against the merge-base with `origin/main` — committed, staged, unstaged, deleted and untracked files alike, so committing does not hide code from it — and if anything under `apps/web/` other than Markdown changed, runs CI's two `tsc` projects, `eslint`, `prettier --check` and `vitest` (`related` while only `src/` changed, else the full suite). Rules tests stay with CI's `rules` job; they need Java. A failure blocks the stop with the tool's output tail. It also scans the change set for what turns a suite green without testing anything — `.skip`/`.only`/`.todo`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, `eslint-disable`, `as any`, a test file losing `expect(` calls, a deleted test file — and blocks once per change set with `file:line`; an intentional hit is explained to the user and the stop repeated. A loosened assertion (`toBe` → `toBeTruthy`) gets past the scan. Results are cached by content digest in `.claude/.verify-cache.json`, so an unchanged change set is not re-verified. Stopping again on an unchanged failing set is allowed with a warning shown to the user: a failure that is red on `main` too must not trap the session, but it is never reported as done in silence. The hook produces its evidence instead of trusting a stamp the agent wrote, yet it is a fast pre-push loop, not a boundary — its cache is writable — and CI remains the gate. Its own tests: `node --test .claude/hooks/verify-on-stop.test.mjs`.

## Architecture

- **Single-page React 19 app** — one route (`/`), one page component (`LiveMidpointPage`), no router
- **Vite 6** with manual chunks: react, firebase, mapbox, i18n
- **Composition root** — `lib/config.ts` is the only module reading `VITE_*` application config; `lib/services.ts` wires Firebase, the API clients and the graph ports once in `main.tsx` and passes them down via `ServicesProvider`. Nothing below that constructs a Firebase handle or reads a credential
- **Firebase Anonymous Auth** — `lib/firebase-factory.ts` builds auth with an explicit persistence fallback chain (IndexedDB → localStorage → in-memory) so strict-privacy browsers still sign in; `signInAnonymously()` on app init, UID as participant key. Failures classify to typed `AuthErrorCode` (network retried 3×, storage-blocked terminal). Tradeoff: under in-memory persistence a reload mints a new anonymous UID, consuming a fresh write-once slot claim
- **Firebase App Check** — reCAPTCHA Enterprise attestation (optional, graceful degradation). Primed at the composition root and exposed as `appCheckReady`, a promise that never rejects. **Anything that can open the RTDB connection awaits it first**: `getDatabase` does not connect, RTDB dials on its first subscription and attaches the token when it establishes the socket, so a subscription that beats the first token leaves that connection unattested for its lifetime. That race — not a misconfiguration — is what held attestation at 11% verified. `useNetworkStatus`'s `.info/connected` listener is the earliest such subscription and is gated accordingly; the wait is bounded by `APP_CHECK_TIMEOUT_MS` and then proceeds unattested, because degrading beats blocking the app on a blocked reCAPTCHA. The outcome (`token` / `timeout` / `error` / `no-appcheck`, plus token latency) is tagged on Sentry, since the console's verified/unverified split cannot tell those apart
- **Firebase Realtime Database** — peer-to-peer location sync, auth-enforced security rules in `infra/database.rules.json`
- **Mapbox GL JS 3.x** — dark-v11 basemap, pre-bundled via `optimizeDeps.include`. Its stylesheet is bundled (imported in `LiveMap.tsx`): the production CSP does not admit it from the CDN, and it must not need to. Right-to-left labels need no plugin since 3.33 — Mapbox lazily fetches a WebAssembly shaping module from api.mapbox.com, which `connect-src https://*.mapbox.com` and `script-src 'unsafe-eval'` admit; dropping either breaks Hebrew labels
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
3. **Joiners** (up to 4) open `/?code=XXXXX` → each claims the lowest free `slots/{1..4}` write-once; the database arbitrates, a loser retries the next index, and all five taken means a genuine `SESSION_FULL`
4. All participant locations stream to Firebase RTDB at `/sessions/{code}/participants/{slot}` (throttled 1 write/3s by the `presence` node, and re-sent every 10s while standing still — peers mark anyone silent for 30s as stale, and stop counting them toward the midpoint and routes after 2 minutes)
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
│   │   ├── useLiveGeolocation.ts      # watchPosition wrapper; only PERMISSION_DENIED is terminal, the rest restart with backoff
│   │   └── useLiveSession.ts          # RTDB create/join/listen; returns Result, takes an AbortSignal
│   └── lib/
│       ├── geo-math.ts                # sphericalMidpoint, geographicCentroid, haversineDistance, accuracyCircleGeoJSON
│       ├── participant-config.ts      # MAX_PARTICIPANTS, ParticipantIndex type, PARTICIPANT_COLORS (5-color palette)
│       ├── session-code.ts            # 6-char code generation/validation
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
│   ├── useNetworkStatus.ts            # Firebase RTDB .info/connected tracking
│   └── useServerTimeOffset.ts         # .info/serverTimeOffset — liveness runs on server time
├── lib/
│   ├── config.ts                      # the ONLY module reading VITE_* app config; validateAppConfig
│   ├── services.ts                    # composition root: createServices(config)
│   ├── firebase-factory.ts            # createFirebaseServices(config) — no module state
│   └── i18n.ts                        # i18next config
└── i18n/                              # en.json, he.json — namespaces: app, live, common
```

Tests are co-located as `*.test.ts` / `*.test.tsx` next to source files. Test environment: jsdom with vitest globals.

Security-rules tests are the exception: they live in `apps/web/rules/`, run in a node environment against the RTDB emulator via `vitest.rules.config.ts`, and are invoked with `npm run test:rules`.

Tests are typechecked. Vitest strips types without checking them, so `tsc` is the only gate that reads a test's types — excluding test files is what let 33 errors accumulate unseen before `#83`. `npm run tsc` runs two projects: `tsconfig.json` (browser — all of `src/`, tests included, no `@types/node`) and `tsconfig.node.json` (`rules/`, the Playwright suites in `e2e/` and `e2e-live/`, the Vite/Vitest/Playwright configs, and `src/lib/register-sw.test.ts`, which reads `public/sw.js` off disk). Node-side files go in the second project's `include`; never add `"node"` to the browser project's `types`, or `process.env` and `Buffer` will typecheck inside a React component.

## Firebase RTDB Schema

```
/sessions/{6charCode}/
  created: number (server timestamp)
  creatorUid: string (write-once, must match auth.uid)
  slots/{0..4}: uid (write-once; exactly five keys may ever exist)
  participants/{slot}: { uid, lat, lng, accuracy, ts, name }   # ts: server timestamp
```

Security rules enforce: auth required for all reads, write-once session metadata, numeric range validation for lat/lng, no extra fields (`$other: false`), session keys in the code generator's alphabet, no claim or position in a session that was never created or is over 24 hours old (a holder may still clear their own position) — and **the participant cap**.

The client has the server stamp both timestamps (`serverTimestamp()`), never the device: every peer judges staleness from `ts`, and phones run minutes off. The rules require it only from the contract step below. Liveness compares them against `Date.now()` plus `.info/serverTimeOffset` (`useServerTimeOffset` → the graph's `serverTimeOffsetMs` source), never the device clock alone.

The cap is a property of the schema, not a client-side check. Exactly five keys are declared under `slots`, each write-once and each validated to equal the writer's `auth.uid`; any other key has no `.write` rule anywhere up the tree and is rejected. `participants/{slot}` is then writable only by whoever holds `slots/{slot}`, which needs no key-pattern matching: since only 0–4 can exist under `slots`, any other participant key resolves to a null holder and is denied for free. Slot 0 additionally validates against `creatorUid`, making "the creator is green" a server invariant.

Claiming is arbitrated by the database rather than by a client registry: two clients racing for one index are serialised, and the loser's `set` is rejected with `permission_denied`, so `claimSlot` in `useLiveSession` retries the next free index. But a rejection is only evidence of a lost race if the index actually ends up held — a rejection with the index still free means the write was denied structurally (stale rules, a revoked token), not that somebody beat us to it. `claimSlot` re-reads to tell those apart and rethrows the second case, because reporting it as `SESSION_FULL` is a lie about an empty session and it is what made the 2026-09-11 outage read as a capacity problem. `SESSION_FULL` is a fact about the session only because that distinction is drawn. Slot claims are deliberately **not** released on disconnect — `onDisconnect` clears `participants/{slot}` only — so a reconnect returns to the same slot and colour. An `onDisconnect` belongs to the connection that registered it — the server runs it once, when that connection drops, then forgets it — so `presence-rtdb.ts` re-arms every published path each time `.info/connected` comes back; `rules/presence-disconnect.test.ts` proves it against the emulator.

Rules are tested against the RTDB emulator (see `rules/database.rules.test.ts`), wired into CI as its own job. Run locally from the repo root:

```bash
npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:rules"
```

`firebase-tools` is deliberately not a devDependency — it is 23 MB and `npm ci` runs in every CI job, so it is invoked pinned at the call sites that need it.

### Rules and client deploy together, or not at all

The `deploy` job publishes hosting **and** `--only database`, in that order. The client's schema and `infra/database.rules.json` are two encodings of one contract; shipping either alone takes production down. That is not hypothetical — on 2026-09-11 the slot-schema client deployed while its rules stayed in the repo, and every slot claim was denied for three days. `infra/**` and `firebase.json` are in the workflow's `paths` filter for the same reason: they are deployable artifacts, and a rules-only change that starts no run can never reach production.

Hosting deploys before rules deliberately. Either order leaves a window during a breaking schema change, but rules-first breaks every already-loaded client the moment the rules land and keeps them broken until they fetch a bundle that has not been published yet; hosting-first only strands clients that load inside the ~30s gap.

**For the next breaking schema change, use expand/contract instead of relying on that ordering:** publish rules that accept both the old and new shapes, deploy, migrate the client, then drop the old shape in a later release. The window becomes zero. `2daf708` should have been shaped that way.

**One is in flight: restricting location reads to slot holders.** The code is at the expand step. The join reads `created` and `creatorUid` field by field, never the session node, and both timestamps are server-stamped; the rules before this step accept all of it too, which is what keeps hosting-first safe. The contract step, a later release, restricts `participants` reads to slot holders (from then on a whole-node read is refused, which is why the join stopped doing one), requires `created` and `ts` to equal `now`, and makes `createSession` one atomic update. That last part cannot ship with the rules that allow it. Slot 0's rule now reads `creatorUid` from `newData`; the rules before this step read it from `root`, the state before the write, and so refuse the atomic form. The three sequential create writes stay until this step's rules are in production.

## Code Conventions

- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`)
- Functional components + hooks only
- Tailwind + custom CSS dark glass-morphism theme (`live-midpoint.css`)
- `const` over `let`, never `var`
- CRS: WGS84 (EPSG:4326) everywhere, GeoJSON `[lng, lat]` order
- `LatLng` type uses `{ lat, lng }` (not arrays) for internal representation
- Session error codes use typed union `SessionErrorCode` (not string matching)
- i18n keys mapped via typed records (e.g., `SESSION_ERROR_I18N`)
- Participant indexing via `ParticipantIndex = 0 | 1 | 2 | 3 | 4` (creator = 0). Slots are **claimed from the database** (`sessions/{code}/slots/{i}`, write-once) and are stable for the session — never renumbered when someone leaves. Anything keyed by slot (routes, accuracy circles, colours, Mapbox layer ids, the RTDB participant key) must agree on that one index space
- Enforce invariants where they cannot be bypassed. A limit a client checks is a limit a modified client ignores: if a rule can express it, the rule owns it
- Fallible operations return `Result<T, E>` from `core/dag/result.ts` rather than throwing, returning an empty value, or writing a state code. This includes the session handshake: `createSession`/`joinSession` return `Result` and take an `AbortSignal`
- Derived values are derived, not stored. `SessionPhase` and participant staleness and departure are graph nodes, not `useState` — a predicate over a clock must never be driven by a polling interval (mobile browsers throttle `setInterval` to minutes and freeze it under bfcache)
- Anything the graph publishes is referentially stable; do not rebuild it with `.map()` in a render body. Project it with `useMemo` keyed on the snapshot array, or the map re-uploads every route geometry per frame
- New effectful work belongs in a `ResourcePolicy` (`graph/policies.ts`), not a bespoke hook with its own debounce and abort handling
- I/O reaches the graph through `graph/ports.ts` so tests inject fakes and a virtual clock instead of mocking modules, globals or timers. React-tree dependencies arrive through `ServicesProvider` for the same reason
- `import.meta.env.VITE_*` is read in `lib/config.ts` and nowhere else (`DEV`/`PROD`/`MODE` are build flags and stay at their point of use)
- Never style the element handed to `mapboxgl.Marker`. Mapbox owns it — the `mapboxgl-marker` class positions it absolutely, its `transform` is rewritten every frame, and it can carry an inline `opacity`. Pass `markerRoot(child)` (`components/marker-root.ts`) and put every class on the child; toggle classes, never assign `className`
- 5-color palette: green (#00d4aa), blue (#6c8cff), orange (#ff9f43), purple (#a855f7), pink (#f472b6) — CSS classes `--p0` through `--p4`
- `public/privacy.html` describes the code, not an intention. A change to what leaves the device, who can read it or how long it is kept updates the policy in the same commit — and where the policy makes a promise, a test holds the code to it: no IP address, position or session code in Sentry reports (`lib/sentry.test.ts`; everything bound for Sentry passes through `scrub`), a position deleted on every dropped connection (`rules/presence-disconnect.test.ts`), and a denied location permission withdrawing presence (`useLiveGeolocation`, `LiveMidpointPage` tests). Session records are never deleted automatically (no scheduled jobs on the Spark plan); the policy says so

## Environment Variables

Required: `VITE_MAPBOX_TOKEN`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_DATABASE_URL`, `VITE_FIREBASE_PROJECT_ID`, `VITE_RECAPTCHA_SITE_KEY` — all six enforced by `validateAppConfig`.
Optional: `VITE_GOOGLE_PLACES_API_KEY` (venue search disabled if not set), `VITE_FIREBASE_APP_ID` (required for App Check — without it the attestation token exchange 400s and App Check init is skipped with a warning).
Test-only: `VITE_RTDB_EMULATOR_HOST` (`host:port`; set in `.env.e2e`). Points the Database handle at the emulator; `validateAppConfig` throws if it is set in a `production`-mode build.

See `.env.example` at project root. `main.tsx` calls `validateAppConfig` before React renders and throws naming every missing variable at once.

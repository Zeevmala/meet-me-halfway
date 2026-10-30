# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed — flows that left people stuck, and deploys that missed open tabs

- **A failed create led into a dead end, or a stranger's session.** The URL
  took the new code before anything was written, so after a failure Retry
  reloaded into a join of a session that did not exist. And `created` is
  write-once, so a code that was already taken failed the create — and that
  same Retry joined whoever held it. The URL now changes only once the
  session exists, and a taken code draws another (up to three)
- **A mangled link silently started a new session.** An invalid `?code=`
  read as no code at all, so the joiner sat alone, believing they had joined.
  It is now refused as an invalid link
- **Some error screens had no way out.** Not found, expired, full and invalid
  link now offer to start a new session
- **Going back to the app could leave it frozen.** Leaving the page shut down
  the listener and GPS, and a page restored from the back/forward cache never
  restarted them; it now reloads. The privacy and terms links open in a new
  tab, so reading them does not leave the session
- **Failures were silent.** The page now says when your location is not
  reaching the others, and the card when routes could not be refreshed. A
  rules denial of the location write was treated as a network failure,
  retried and counted towards the circuit breaker; it is now neither
- **Straight-line distances measured to the wrong place.** With a venue
  picked and no route yet, they measured to the midpoint
- **Deploys reach open tabs.** A tab reloads when a new service worker takes
  it over, and checks for one whenever it comes back into view; the page is
  served `no-cache`; a chunk removed by a deploy triggers one reload instead
  of the error screen; and deploys run one at a time, so two quick pushes
  cannot ship a client and rules from different commits

### Fixed — holes in the database rules

- **Slot claims under codes no session had.** Any signed-in client could
  claim slots 1–4, then write positions, under any key: nodes nobody could
  read, with no limit on how many. A claim, slot 0 included, now needs a
  session created within the last 24 hours, and session keys must be codes
  the app can generate
- **Expired sessions still took writes.** After 24 hours a session refused
  reads but accepted new claims and positions. It now refuses both; a holder
  can still clear their own position
- Shaped as the **expand** step: these rules accept the client in production
  today, and that client works under them, so the hosting-first deploy has no
  broken window. The contract step — location reads for slot holders only,
  server-time equality for `created` and `ts`, an atomic create — follows in
  a later release

### Fixed — presence, liveness and routes

- **A participant standing still went stale.** Presence was only re-offered
  when something else ticked, so with GPS quiet nothing was written while
  peers mark anyone silent for 30 s as stale. A 10 s heartbeat now keeps it
  fresh while sharing
- **Device clocks decided who was stale.** `ts` and `created` were the
  writer's `Date.now()`, so a phone minutes off looked stale to everyone, or
  live after it had left. The server stamps both now, and liveness compares
  them against server time (`.info/serverTimeOffset`)
- **Departed participants kept pulling the midpoint.** A peer silent for two
  minutes is still drawn, dimmed, but no longer counts toward the midpoint,
  the routes or the "connected" state
- **Routes outlived what they answered.** Routes to a venue no longer picked,
  or for a participant who had left, stayed on the map and in the card until
  a new fetch replaced them — and after the last peer left, none ever did.
  Routes are now tagged with the destination and profile they were fetched
  for, and hidden once they no longer answer them
- **The join read the whole session**, participants included, before holding
  a slot. It reads `created` and `creatorUid` only, which the contract step
  requires

### Fixed — the map under the production CSP

- **Markers were off-screen in production.** Mapbox's stylesheet was loaded
  with an inline `onload` swap, which the CSP (no `'unsafe-inline'`) refuses,
  so it never applied: the canvas lost `position: absolute` and every marker
  was laid out below the map. The stylesheet is now bundled with the map, and
  pinned to the installed mapbox-gl rather than an older CDN version
- **Markers were offset everywhere.** `.live-marker { position: relative }`
  overrode Mapbox's absolute positioning, so each marker was drawn lower by
  the height of the markers before it (the midpoint by ~30px with two
  participants), and venue selection wiped Mapbox's classes by assigning
  `className`. Mapbox is now handed a bare root (`markerRoot`) and every class
  lives on its child
- **Hebrew map labels.** The RTL text plugin was `import()`ed from
  api.mapbox.com, which the CSP's `script-src` does not admit. mapbox-gl
  3.33 removes the plugin and shapes RTL text itself, with a WebAssembly
  module the CSP already admits
- **E2E can see the map.** `vite preview` serves firebase.json's headers, and
  the suite runs the real client against the RTDB emulator loaded with the
  real rules. A new two-device spec checks for CSP violations and asserts
  where the markers are drawn; it fails on the code before this change

### Fixed — the privacy policy now describes what the app does

- **Rewritten against the code.** The old policy said sessions are deleted
  after 24 hours; nothing is ever deleted automatically, and after 24 hours
  the rules only refuse to read a session. It said locations are visible
  only to participants; anyone with the code can read them. It also left out
  Google reCAPTCHA, Mapbox's map tiles and telemetry identifier, the
  device-type display name every participant publishes by default, and what
  stays on the device. It now says all of that. The terms list reCAPTCHA too
- **Positions lingered after a reconnect.** `onDisconnect` was armed once per
  session, but the server forgets it after the first drop, so after any
  reconnect the next drop left the last position stored indefinitely. It is
  re-armed on every connection, proven against the emulator
- **Sentry reports carried locations and the session code.** The Directions
  URL — every participant's coordinates, in its path — rode along as a fetch
  breadcrumb, and the page URL and Firebase's own warnings carried the full
  session code. Errors, breadcrumbs and spans are now scrubbed before they
  leave; checked with the real SDK in a browser, before and after
- **Revoking location permission did not stop sharing.** The last fix stood,
  and the presence heartbeat re-published it as live. A denial now clears it
  and withdraws presence, while staying in the session so a retry resumes

### Changed — dependency baseline

- **Audit gate green again.** re2js 2.9.1 (GHSA-gg6h-894w-4m9c, via
  @firebase/firestore, not bundled) had failed `lint` on main and every PR
- mapbox-gl 3.33 (RTL built in, see above), react 19.3.1, i18next 26.5.3,
  react-i18next 17.1.0
- firebase 13 with @firebase/rules-unit-testing 6, which only install
  together; CI moves to Node 24, which rules-unit-testing 6 requires, and
  @types/node to 24 to match
- **Sentry 11 without new data collection.** v11's unset `dataCollection`
  stores reporters' IP addresses; it is pinned to the v10 defaults that
  privacy.html describes, and a test holds it there
- Dependabot opens one grouped PR per ecosystem instead of one per package

### P3 — Declared Execution Graph

- **DAG pipeline** — `slots → midpoint → venues → destination → routes → frame`
  declared in `features/live-midpoint/graph/edges.ts` and executed in
  topological order. `assertAcyclic` (Kahn) runs at module load, so the cycle
  that appears when venue search is re-centred on the selected venue — or a
  midpoint is derived from route durations — fails a test instead of hanging a
  phone. See `ARCHITECTURE.md`
- **`core/dag`** — framework- and domain-agnostic execution core: `Result<T, E>`,
  a closed `ResourceError` union, a lazy circuit breaker, shared backoff, and
  one `createResource` combinator carrying debounce + starvation ceiling,
  admission control, in-flight de-duplication, abort, timeout, retry and
  last-known-good degradation
- **Stable participant slots** — `lib/slot-registry.ts` replaces a dense rank
  over a mutating set with first-seen-wins allocation that survives departures
- **Atomic snapshot** — one `useSyncExternalStore` subscription replaces the
  four-hook render cascade; `setSources` takes a patch so multi-field updates
  produce a single render
- **Injected ports** — `graph/ports.ts` is the I/O seam; tests drive a virtual
  clock and fake fetchers instead of mocking modules, globals or timers
- **344 tests** — 62 new, covering slot allocation, the breaker state machine,
  the resource combinator, graph acyclicity, policy thresholds and the runtime
- `useDirections` and `useVenueSearch` retired; their behaviour is now two
  `ResourcePolicy` values

### Fixed (P3)

- **Route/colour misalignment** — `LiveMap` resolved accuracy circles by
  participant index but routes by array position while painting both into slot
  `i`'s colour. For any joiner the two disagreed, so every route rendered under
  the wrong participant. `MidpointCard` consumed the same array
  correctly-by-position, so neither consumer could be fixed alone
- **Slot collisions** — own index was ranked over `participantUids` while other
  participants were ranked over `participants`; those sets diverge whenever
  somebody is registered but has not yet reported a position, so two
  participants could share a slot and one accuracy circle would vanish. A
  clamp also aliased surplus uids onto the last slot
- **Sticky rate limit** — a 429 doubled the debounce delay, but the movement
  guard returned before the timer was re-armed, so a stationary user never
  recovered. The breaker now recovers on an elapsed cooldown
- **Partial-failure wipeout** — `Promise.all` meant one participant's 429
  discarded every route and left stale ones on screen unflagged; slots now
  settle independently
- **Debounce starvation** — both fetch hooks reset their timer on every
  dependency change, and dependencies change at GPS rate, so the first fetch
  could be starved for as long as a user kept walking
- **Loading flicker** — `useVenueSearch` checked the captured signal on success
  but the *current* controller in `catch`/`finally`, so an abandoned request
  cleared `loading` under its replacement
- **Pinned stale venue** — reconciliation only ran when the venue list was
  non-empty, so an empty search left a deleted venue as the destination
  indefinitely; it is now a pure derivation
- **Unreachable 429** — `searchNearbyVenues` threw `RATE_LIMITED` then caught it
  in its own catch block, returning `[]`; callers could not distinguish a rate
  limit from "no venues here", so nothing could back off

### P2 — Robustness
- **GPS error handling** — dedicated UI for denied, unavailable, and timeout states with retry button
- **Offline/reconnect banner** — `useNetworkStatus` hook tracks Firebase RTDB `.info/connected`
- **24h session expiry** — joiner rejected with `SESSION_EXPIRED` error if session older than 24h
- **Auth retry** — `signInAnonymously()` retries 3 times with exponential backoff (1s, 2s, 4s)
- **SessionErrorCode** — typed union replaces fragile error string matching in `useLiveSession`
- **App Check optional** — graceful degradation when reCAPTCHA Enterprise unavailable
- **Vite pre-bundling fix** — `optimizeDeps.include: ["mapbox-gl"]` resolves CJS/ESM interop crash
- **CI test job** — `npx vitest run` added to GitHub Actions workflow
- **147 tests** — 44 new tests covering GPS errors, directions, venue search, page lifecycle, session expiry, auth retry
- **Code review fixes** — `console.warn` for silent errors, `--live-red` CSS variable, `aria-pressed`/`aria-selected` accessibility

### Publish-Ready
- **MIT License** added
- Stripped exposed reCAPTCHA site key from `.env.example` and README
- Portfolio-grade README with shields.io badges, Mermaid architecture diagram, env var table, project structure
- Enhanced OG meta tags + Twitter card (`summary_large_image`)
- Added Firebase service account patterns to `.gitignore`

### Added
- **Live midpoint feature** — real-time 2-person location tracking with spherical great-circle midpoint computation
- **RTDB write throttle** — max 1 write per 3s with leading+trailing edge pattern, preserves UI responsiveness
- **GPS accuracy circles** — GeoJSON fill+outline layers using spherical direct formula (green A, blue B)
- **Stale partner detection** — 30s threshold triggers dimmed marker (grayscale + opacity) + warning banner
- **Smooth map transitions** — 50m movement threshold suppresses GPS jitter, easeTo/fitBounds with maxZoom 16
- **Venue search** — Google Places API (New) nearby search within 1km, 5s stability delay, 100m cache radius
- **Venue ranking** — composite formula: 0.40 rating + 0.30 proximity + 0.20 popularity + 0.10 open_now (14 tests)
- **VenueListCard** — glass-morphism card with loading shimmer, ranked venue list, tap-to-select/deselect
- **VenueMarker** — map markers for venues (gray dot / green selected) with truncated name labels
- **Travel profile toggle** — segmented driving/walking switch in MidpointCard, conditional ETA labels
- **Bottom panel layout** — flex container stacks VenueListCard above MidpointCard with pointer-events passthrough
- Firebase RTDB peer-to-peer session sync with 6-character codes
- Mapbox Directions API dual routing to venue or midpoint with 200m movement threshold
- Dark glass-morphism UI: LiveMap, SessionBadge, WaitingCard, MidpointCard
- Continuous geolocation streaming via `watchPosition`
- WhatsApp share + copy link for session invites
- Waze / Google Maps navigation deep links
- i18n support: English, Hebrew, Arabic with full RTL
- PWA: manifest, service worker (shell + tile caching), offline fallback
- CI: ESLint + TypeScript check + Vite build (.github/workflows/web.yml)

### Changed
- **Architecture:** Stripped to zero-backend PWA (removed FastAPI, PostGIS, WhatsApp bot, Expo mobile app, Terraform, Docker)
- Upgraded `firebase` from 10.14.1 → 11.10.0 (resolves 10 `undici` vulnerabilities)
- Simplified service worker — removed dead `/api/` caching strategy
- Cleaned Tailwind config — removed stale venue color tokens and font stack

### Removed
- `apps/api/` — entire FastAPI backend
- `apps/mobile/` — Expo/React Native app
- `packages/shared/` — shared TypeScript types
- `infra/terraform/` — GCP Cloud Run/Cloud SQL IaC
- `docker-compose.yml`
- Venue-flow components (Map, VenueList, VenueCard, etc.)
- `useNetworkStatus` hook (unused)
- Dead `.live-toast` CSS + `@keyframes live-toast-in`

### Fixed
- Missing `session.updateOwnLocation` in useEffect dependency array
- `LanguageSwitcher` buttons missing `type="button"` attribute
- Broken favicon reference (centroid-pin.svg → midpoint-pin.svg)
- `console.warn` calls in production hooks (useDirections, useLiveSession)
- Manifest/index.html theme-color mismatched with dark UI (`#1a73e8` → `#0a0a0f`)

### QA & Security Hardening
- **Firebase Anonymous Auth** — all RTDB operations gated behind `signInAnonymously()`, UID as participant key
- **Firebase App Check** with reCAPTCHA Enterprise — client attestation for all RTDB operations
- Auth-enforced RTDB rules: reads require auth, participant writes scoped to own UID (`$uid === auth.uid`)
- Session metadata (`creatorUid`, `joinerUid`) is write-once and must match `auth.uid`
- RTDB schema migration: `live-sessions/{code}/{a|b}` → `sessions/{code}/participants/{uid}`
- App Check debug token moved to side-effect module for correct ES module load order
- 147 unit + integration tests: geo-math, accuracy circles, session-code, useAuth (7 + retry), useLiveSession (23 + throttle/stale/expiry), venue ranking (14), GPS errors, directions, page lifecycle
- Resolved 10 npm vulnerabilities by upgrading firebase to v11 (dropped `undici` transitive dep)
- Fixed Vite HMR WebSocket (`server.hmr.host`), mapbox-gl optimizeDeps, Mapbox CSS CDN version mismatch
- Firebase deployment config (`firebase.json`, `.firebaserc`)
- 2 remaining vulnerabilities: `esbuild ≤0.24.2` (moderate, dev-only via vite — no production impact)

# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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

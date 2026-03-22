# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
- 103 unit tests: geo-math, accuracy circles, session-code, useAuth (7), useLiveSession (23 + throttle/stale), venue ranking (14)
- Resolved 10 npm vulnerabilities by upgrading firebase to v11 (dropped `undici` transitive dep)
- Fixed Vite HMR WebSocket (`server.hmr.host`), mapbox-gl optimizeDeps, Mapbox CSS CDN version mismatch
- Firebase deployment config (`firebase.json`, `.firebaserc`)
- 2 remaining vulnerabilities: `esbuild ≤0.24.2` (moderate, dev-only via vite — no production impact)

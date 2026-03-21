# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Live midpoint feature** — real-time 2-person location tracking with spherical great-circle midpoint computation
- Firebase RTDB peer-to-peer session sync with 6-character codes
- Mapbox Directions API dual routing (A→midpoint, B→midpoint) with 3s debounce
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
- 76 unit tests: geo-math, session-code, useAuth (7), useLiveSession (23)
- Resolved 10 npm vulnerabilities by upgrading firebase to v11 (dropped `undici` transitive dep)
- Fixed Vite HMR WebSocket (`server.hmr.host`), mapbox-gl optimizeDeps, Mapbox CSS CDN version mismatch
- Firebase deployment config (`firebase.json`, `.firebaserc`)
- 2 remaining vulnerabilities: `esbuild ≤0.24.2` (moderate, dev-only via vite — no production impact)

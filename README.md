# Meet Me Halfway

A live midpoint PWA for two people. Share a link, both locations stream in real-time, and the app computes a fair meeting point with driving routes.

**Zero backend** — fully client-side, talks directly to Firebase RTDB and Mapbox Directions API. Deployable as a static site to Firebase Hosting, Vercel, or Netlify.

## Current Status

### What's Working
- **Auth & Security** — Firebase Anonymous Auth + App Check (reCAPTCHA Enterprise), auth-enforced RTDB rules with uid-scoped writes
- **Session Codes** — 6-character code generation, URL-based sharing (WhatsApp / copy link)
- **Live Streaming** — Both participants stream GPS coords to RTDB in real-time (throttled to 1 write/3s)
- **Real-time Midpoint** — Spherical great-circle midpoint updates live as either participant moves
- **Map** — Mapbox GL JS 3.x dark basemap with participant markers, accuracy circles, colored route polylines, smooth transitions
- **Stale Detection** — Partner offline > 30s triggers dimmed marker + warning banner
- **Directions** — Mapbox Directions API dual routing (A→midpoint, B→midpoint) with 3s debounce
- **Navigation** — Waze / Google Maps deep links for turn-by-turn directions
- **i18n** — English, Hebrew, Arabic with full RTL support
- **PWA** — Manifest, service worker, offline fallback, installable
- **Tests** — 89 unit tests (geo-math, session-code, useAuth, useLiveSession throttle/stale, accuracy circles)
- **CI** — ESLint + TypeScript check + Vite build (.github/workflows/web.yml)
- **Dev Tooling** — Vite HMR, App Check debug tokens, pre-commit hooks

### v1 MVP — Remaining
- Venue/POI search around midpoint (Google Places API)
- E2E tests for full session lifecycle

### v2 — Future
- WhatsApp bot for session creation and invites
- E2E tests for full session lifecycle

## How It Works

1. Open the app → Firebase Anonymous Auth signs in silently → geolocation prompt
2. 6-character session code generated → share the link (WhatsApp / copy) → partner opens it
3. Both locations stream to Firebase RTDB in real-time (uid-scoped writes, auth-enforced rules)
4. Client computes spherical great-circle midpoint
5. Mapbox Directions API fetches driving routes for both participants
6. Dark map shows colored routes, distances, drive times, and navigation links (Waze / Google Maps)

## Tech Stack

| Layer | Tech |
|-------|------|
| UI | React 18 + Vite + Tailwind CSS |
| Maps | Mapbox GL JS 3.x (dark-v11 basemap) |
| Auth | Firebase Anonymous Auth (silent sign-in) |
| Security | Firebase App Check (reCAPTCHA Enterprise) |
| Real-time | Firebase 11 Realtime Database |
| Routing | Mapbox Directions API (client-side) |
| Midpoint | Spherical great-circle formula |
| i18n | i18next — English, Hebrew, Arabic (full RTL) |

## Quick Start

```bash
# 1. Clone and install
cd apps/web
npm install

# 2. Set environment variables
cp ../../.env.example ../../.env
# Edit .env with your keys

# 3. Run dev server
npm run dev
# Opens at http://localhost:5173
```

## Environment Variables

Create `.env` at the project root:

```
VITE_MAPBOX_TOKEN=pk.your_mapbox_public_token
VITE_FIREBASE_API_KEY=your_firebase_api_key
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_RECAPTCHA_SITE_KEY=your_recaptcha_enterprise_site_key
```

## Build & Deploy

```bash
cd apps/web
npm run build     # Output in dist/
```

Deploy `dist/` to any static host:
- **Firebase Hosting:** `firebase deploy`
- **Vercel:** connect repo, set root to `apps/web`
- **Netlify:** set build dir to `apps/web/dist`

## Development

```bash
npm run dev       # Vite dev server with HMR
npm run tsc       # TypeScript check
npm run build     # Production build
```

## App Check Debug Token

In development, App Check uses a debug token. On first run, a debug token is printed to the browser console. Register it in the Firebase Console under **App Check → Apps → Manage debug tokens**.

## i18n

Three locales with full RTL support: English (`en`), Hebrew (`he`), Arabic (`ar`). Translation files in `apps/web/src/i18n/`.

## License

Private — all rights reserved.

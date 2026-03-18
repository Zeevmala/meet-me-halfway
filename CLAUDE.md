# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Meet Me Halfway** — a client-side PWA that computes a live midpoint between two people and shows driving routes to the meeting point. Zero backend. Fully static, deployable to Firebase Hosting / Vercel / Netlify.

## Architecture

- **PWA:** React 18 + Vite + Mapbox GL JS 3.x + Tailwind CSS
- **Real-time:** Firebase Realtime Database (peer-to-peer location sync)
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
│   │   ├── hooks/                     # useFirebase
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
├── .github/workflows/web.yml          # CI: lint + typecheck + build
├── .env.example                       # 5 VITE_* env vars
└── README.md
```

## Core Flow

1. **Creator** opens `/` → geolocation prompt → 6-char session code generated → URL becomes `/?code=XXXXX`
2. **Joiner** opens `/?code=XXXXX` → geolocation prompt → joins as participant B
3. Both locations stream to Firebase RTDB at `/live-sessions/{code}/{a|b}`
4. Client computes spherical midpoint + fetches Mapbox driving routes
5. Dark map shows colored polylines (green A → midpoint, blue B → midpoint)
6. Cards show distances, drive times, Waze/Google Maps navigation links

## Environment Variables

```
VITE_MAPBOX_TOKEN        # Mapbox public token (pk.*)
VITE_FIREBASE_API_KEY    # Firebase Web API key
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_DATABASE_URL
VITE_FIREBASE_PROJECT_ID
```

## Dev Commands

```bash
cd apps/web
npm install
npm run dev        # Vite dev server at localhost:5173
npm run tsc        # TypeScript check (tsc --noEmit)
npm run build      # Production build
```

## Firebase RTDB Schema

```
/live-sessions/{6charCode}/
  created: number (timestamp)
  a: { lat, lng, accuracy, ts }
  b: { lat, lng, accuracy, ts }
```

Security rules: `/infra/database.rules.json` — validates numeric ranges, rejects unknown keys.

## i18n

Locales: `en`, `he` (Hebrew), `ar` (Arabic). Full RTL support via CSS logical properties. Namespaces: `app`, `live`, `common`.

## Code Style

- TypeScript strict mode, ES modules
- Functional components + hooks (no class components)
- Tailwind + custom CSS for dark glass-morphism theme
- `const` over `let`, never `var`
- CRS: WGS84 (EPSG:4326) everywhere, GeoJSON `[lng, lat]` order

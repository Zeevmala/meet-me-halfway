# Meet Me Halfway

**A real-time midpoint PWA for up to 5 participants.** Share a link, stream locations live, find nearby venues, and meet in the middle — all from the browser.

![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)
![Mapbox](https://img.shields.io/badge/Mapbox_GL-3.x-000?logo=mapbox&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-11-FFCA28?logo=firebase&logoColor=black)
![License](https://img.shields.io/badge/License-MIT-green)

<!-- Screenshot / demo GIF placeholder -->
<!-- ![Meet Me Halfway Screenshot](docs/screenshot.png) -->

> **Zero backend** — fully client-side PWA. Talks directly to Firebase RTDB and Mapbox APIs. Deployable as a static site.

---

## Features

- **Multi-Participant** — Up to 5 participants per session with color-coded markers (green, blue, orange, purple, pink)
- **Live Location Streaming** — All participants stream GPS coords via Firebase RTDB in real-time
- **Geographic Centroid** — Cartesian mean on unit sphere updates live as any participant moves
- **Venue Search** — Google Places API finds nearby restaurants, cafes, and bars ranked by rating, proximity, popularity, and open status
- **N-Participant Routing** — Mapbox Directions API shows driving or walking routes for all participants to the meeting point
- **Dark Map UI** — Mapbox GL JS 3.x dark basemap with glass-morphism cards, accuracy circles, and smooth transitions
- **Navigation Links** — One-tap Waze / Google Maps deep links to the selected venue or midpoint
- **Session Codes** — 6-character codes with WhatsApp share and copy-link for instant invites
- **Stale Detection** — Per-participant offline detection (> 30s) triggers dimmed marker + warning banner
- **Error Handling** — GPS denied/unavailable/timeout with retry, offline/reconnect banner, 24h session expiry
- **App Check** — Firebase App Check with reCAPTCHA Enterprise (optional, graceful degradation)
- **i18n + RTL** — English, Hebrew, Arabic with full RTL support via CSS logical properties
- **PWA** — Installable, offline fallback, service worker caching
- **162 Unit + Integration Tests** — geo-math, session codes, auth (retry), live session (throttle/stale/expiry), venue ranking, GPS errors, directions, page lifecycle

---

## Live Demo

**[meet-me-halfway-4ae79.web.app](https://meet-me-halfway-4ae79.web.app)**

---

## Architecture

```mermaid
graph TB
    subgraph "Browser 1"
        A[React PWA]
    end
    subgraph "Browser 2..5"
        B[React PWA]
    end
    subgraph "Firebase"
        AUTH[Anonymous Auth]
        AC[App Check]
        RTDB[(Realtime DB)]
    end
    subgraph "APIs"
        MB[Mapbox Directions]
        GP[Google Places]
    end

    A -->|signInAnonymously| AUTH
    B -->|signInAnonymously| AUTH
    A -->|reCAPTCHA| AC
    B -->|reCAPTCHA| AC
    A <-->|location sync| RTDB
    B <-->|location sync| RTDB
    A -->|routes| MB
    B -->|routes| MB
    A -.->|venue search| GP
```

All browsers compute the midpoint client-side using a geographic centroid (Cartesian mean on unit sphere) — no server needed.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| UI | React 18 + Vite + Tailwind CSS |
| Maps | Mapbox GL JS 3.x (dark-v11 basemap) |
| Auth | Firebase Anonymous Auth (silent sign-in) |
| Security | Firebase App Check (reCAPTCHA Enterprise) |
| Real-time | Firebase 11 Realtime Database |
| Routing | Mapbox Directions API (client-side) |
| Venues | Google Places API (New) — optional |
| Midpoint | Geographic centroid (Cartesian mean on unit sphere) |
| i18n | i18next — English, Hebrew, Arabic (full RTL) |
| Tests | Vitest + React Testing Library (162 tests) |

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/zeevmala/meet-me-halfway.git
cd meet-me-halfway

# 2. Install dependencies
cd apps/web
npm install

# 3. Configure environment
cp ../../.env.example ../../.env
# Edit .env with your API keys (see table below)

# 4. Start dev server
npm run dev
# Opens at http://localhost:5173
```

---

## Environment Variables

Create a `.env` file at the project root:

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_MAPBOX_TOKEN` | Yes | Mapbox public token (`pk.*`) for map rendering + Directions API |
| `VITE_FIREBASE_API_KEY` | Yes | Firebase Web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | Firebase Auth domain (`*.firebaseapp.com`) |
| `VITE_FIREBASE_DATABASE_URL` | Yes | Firebase RTDB URL (`https://*.firebaseio.com`) |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `VITE_RECAPTCHA_SITE_KEY` | Yes | reCAPTCHA Enterprise site key for App Check |
| `VITE_GOOGLE_PLACES_API_KEY` | No | Google Places API key — venue search disabled if not set |

---

## Project Structure

```
meet-me-halfway/
├── apps/web/                      # React PWA
│   ├── src/
│   │   ├── features/live-midpoint/    # Core feature
│   │   │   ├── LiveMidpointPage.tsx   # Page orchestrator
│   │   │   ├── components/            # LiveMap, markers, cards
│   │   │   ├── hooks/                 # useGeolocation, useSession, useDirections, useVenueSearch
│   │   │   ├── lib/                   # geo-math, venue-ranking, places-api, nav-links
│   │   │   └── styles/               # Dark glass-morphism theme
│   │   ├── hooks/                     # useFirebase, useAuth, useNetworkStatus
│   │   ├── i18n/                      # en.json, he.json, ar.json
│   │   └── main.tsx
│   ├── public/                        # PWA manifest, service worker, icons
│   └── package.json
├── infra/
│   ├── database.rules.json            # Firebase RTDB security rules
│   └── firebase.json                  # Firebase Hosting config
├── .github/workflows/web.yml          # CI: lint + typecheck + test + build
├── .env.example
└── LICENSE
```

---

## How It Works

1. **Auth** — Firebase Anonymous Auth signs in silently on app load
2. **Create** — 6-character session code generated, URL becomes `/?code=XXXXX`
3. **Join** — Up to 4 others open the shared link and join the session
4. **Stream** — All locations stream to Firebase RTDB (throttled to 1 write/3s, uid-scoped)
5. **Midpoint** — Client computes geographic centroid in real-time
6. **Routes** — Mapbox Directions API fetches driving/walking routes for all participants
7. **Venues** — Google Places API searches nearby; ranked by rating, proximity, popularity, open status
8. **Navigate** — Tap a venue to pin as meeting point; one-tap Waze/Google Maps navigation

---

## Testing

```bash
cd apps/web
npx vitest run     # 162 unit + integration tests
npm run tsc        # TypeScript strict mode check
```

---

## Build & Deploy

```bash
cd apps/web
npm run build      # Output in dist/
```

Deploy `dist/` to any static host:
- **Firebase Hosting:** `firebase deploy`
- **Vercel:** connect repo, set root to `apps/web`
- **Netlify:** set build dir to `apps/web/dist`

---

## App Check Debug Token

In development, App Check uses a debug token. On first run, a debug token is printed to the browser console. Register it in the Firebase Console under **App Check > Apps > Manage debug tokens**.

---

## i18n

Three locales with full RTL support: English (`en`), Hebrew (`he`), Arabic (`ar`).
Translation files in `apps/web/src/i18n/`.

---

## License

[MIT](LICENSE) — Zeev Mala

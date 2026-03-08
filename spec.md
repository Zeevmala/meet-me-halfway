# Meet Me Halfway — Technical Specification

**Version:** 1.0.0-draft
**Date:** 2026-03-07
**Author:** Ze'ev (Project Lead / Spatial Algorithm Engineer)
**Status:** Pre-Development

---

## 1. Product Overview

**Meet Me Halfway** is a geospatial feature for WhatsApp that calculates a fair meeting point between 2–5 participants and recommends high-quality POIs at that midpoint. It extends WhatsApp's existing location-sharing capabilities (live location, send current location) with an intelligent "find the middle" flow.

### 1.1 User Flow

1. User A opens WhatsApp → taps "Meet Me Halfway" (bot command or share link)
2. Bot creates a session → generates a shareable link
3. Participants B–E open the link → grant location permission
4. System computes geodesic centroid of all participants
5. Google Places API returns ranked POIs near the midpoint
6. Participants vote/select a venue → navigation links generated
7. Session expires after meetup or TTL

### 1.2 Distribution Model

WhatsApp Business API bot + PWA web app opened via share links. The bot handles session lifecycle; the PWA handles map visualization and venue selection.

---

## 2. Architecture

### 2.1 System Diagram

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  WhatsApp    │────▶│  WhatsApp Biz    │────▶│  FastAPI Backend │
│  Client      │◀────│  API (Webhook)   │◀────│  (Cloud Run)     │
└──────────────┘     └──────────────────┘     └────────┬─────────┘
                                                       │
       ┌──────────────────┐                   ┌────────▼─────────┐
       │  PWA Web App     │◀─────────────────▶│  Firebase RTDB   │
       │  (Mapbox GL JS)  │                   │  (Real-time sync)│
       └──────────────────┘                   └──────────────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  Cloud SQL       │
                                              │  (PostGIS)       │
                                              └──────────────────┘
                                                       │
                                              ┌────────▼─────────┐
                                              │  Google Places   │
                                              │  API             │
                                              └──────────────────┘
```

### 2.2 Component Breakdown

| Component | Technology | Role |
|-----------|-----------|------|
| Bot Interface | WhatsApp Business API (Cloud API) | Session creation, link sharing, notifications |
| Web App (PWA) | React + Mapbox GL JS + Vite | Map UI, venue selection, voting |
| Mobile App | React Native + Expo (dev builds) + @rnmapbox/maps | Native iOS/Android experience |
| Backend API | Python 3.12 + FastAPI + uvicorn | Spatial computation, session mgmt, Places proxy |
| Real-time Layer | Firebase Realtime Database | Location sync, session state, presence |
| Spatial DB | Cloud SQL PostgreSQL 15 + PostGIS 3.4 | Session persistence, spatial queries, analytics |
| Basemap | Mapbox GL JS (web) / Mapbox Maps SDK (mobile) | Vector tiles, directions, geocoding |
| POI Data | Google Places API (New) | Venue search, details, photos, ratings |
| Hosting | GCP Cloud Run (auto-scaling) | Serverless container deployment |
| CDN | Cloud CDN / Firebase Hosting | PWA static assets |

### 2.3 CRS Strategy

**WGS84 (EPSG:4326) throughout the entire stack.**

- All client-side coordinates: WGS84 longitude/latitude
- Firebase storage: GeoJSON `[lng, lat]`
- PostGIS column: `GEOMETRY(Point, 4326)`
- Mapbox: native WGS84
- Geodesic computations: direct on ellipsoid (no projection required)

No CRS transformations needed. Geodesic distance/centroid functions operate directly on WGS84 coordinates using the Karney (2013) algorithm via `geographiclib`.

---

## 3. Core Spatial Algorithm

### 3.1 Geodesic Centroid (Vincenty/Karney)

The midpoint is computed as the **geodesic centroid** of N participant locations (2 ≤ N ≤ 5) on the WGS84 ellipsoid.

**Algorithm:** Iterative geodesic mean using Karney's `geographiclib`:

1. Convert all participant `(lat, lng)` to ECEF (Earth-Centered, Earth-Fixed) Cartesian coordinates
2. Compute arithmetic mean of ECEF vectors
3. Convert back to geodetic `(lat, lng)`
4. For N=2: direct geodesic midpoint via `Geodesic.WGS84.Inverse()` + `Geodesic.WGS84.Direct()` at half-distance

**Precision:** Sub-meter accuracy globally. No projection bias.

**Library:** `geographiclib` (Python) — Karney's C++ algorithm with Python bindings.

### 3.2 POI Search Radius

Dynamic radius based on participant spread:

```
radius = max(500, min(5000, max_pairwise_distance / 4))
```

- Minimum: 500m (dense urban)
- Maximum: 5000m (suburban/rural)
- Scaled by the maximum pairwise geodesic distance between any two participants

### 3.3 POI Ranking Formula

```
score = (0.40 × rating_norm) + (0.30 × distance_penalty) + (0.20 × popularity_norm) + (0.10 × open_now_bonus)
```

| Factor | Weight | Source |
|--------|--------|--------|
| `rating_norm` | 0.40 | Google Places rating (1–5) → normalized 0–1 |
| `distance_penalty` | 0.30 | 1 - (dist_to_centroid / search_radius) |
| `popularity_norm` | 0.20 | `user_ratings_total` log-normalized |
| `open_now_bonus` | 0.10 | 1.0 if open, 0.0 if closed/unknown |

---

## 4. Data Model

### 4.1 PostGIS Schema

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active | completed | expired
    centroid GEOMETRY(Point, 4326),
    search_radius_m FLOAT,
    locale VARCHAR(10) NOT NULL DEFAULT 'en',
    max_participants SMALLINT NOT NULL DEFAULT 5
);

CREATE TABLE participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    phone_hash VARCHAR(64),  -- SHA-256 of phone number
    display_name VARCHAR(100),
    location GEOMETRY(Point, 4326),
    updated_at TIMESTAMPTZ,
    UNIQUE(session_id, phone_hash)
);

CREATE TABLE selected_venues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    place_id VARCHAR(300) NOT NULL,  -- Google Places ID
    name VARCHAR(300),
    location GEOMETRY(Point, 4326),
    votes SMALLINT DEFAULT 0,
    selected BOOLEAN DEFAULT false
);

CREATE INDEX idx_sessions_status ON sessions(status) WHERE status = 'active';
CREATE INDEX idx_participants_session ON participants(session_id);
CREATE INDEX idx_participants_location ON participants USING GIST(location);
CREATE INDEX idx_venues_session ON selected_venues(session_id);
```

### 4.2 Firebase Realtime DB Structure

```json
{
  "sessions": {
    "<session_id>": {
      "status": "active",
      "created_at": 1709827200000,
      "participants": {
        "<participant_id>": {
          "display_name": "Ze'ev",
          "lat": 31.2530,
          "lng": 34.7915,
          "updated_at": 1709827260000
        }
      },
      "centroid": {
        "lat": 31.7683,
        "lng": 35.2137
      },
      "venues": {
        "<venue_id>": {
          "place_id": "ChIJ...",
          "name": "Café Roma",
          "votes": { "<participant_id>": true }
        }
      }
    }
  }
}
```

Firebase security rules enforce: participants can only write their own location; centroid is server-written only.

---

## 5. API Specification

### 5.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/sessions` | Create new session |
| GET | `/api/v1/sessions/{id}` | Get session state |
| POST | `/api/v1/sessions/{id}/join` | Join session with location |
| PUT | `/api/v1/sessions/{id}/location` | Update participant location |
| GET | `/api/v1/sessions/{id}/midpoint` | Compute and return midpoint + POIs |
| POST | `/api/v1/sessions/{id}/vote` | Vote for a venue |
| DELETE | `/api/v1/sessions/{id}` | End session |

### 5.2 Midpoint Response

```json
{
  "centroid": { "lat": 31.7683, "lng": 35.2137 },
  "search_radius_m": 1200,
  "participants_count": 3,
  "venues": [
    {
      "place_id": "ChIJ...",
      "name": "Café Roma",
      "location": { "lat": 31.7690, "lng": 35.2145 },
      "rating": 4.5,
      "price_level": 2,
      "distance_to_centroid_m": 85,
      "open_now": true,
      "score": 0.87,
      "types": ["cafe", "restaurant"]
    }
  ]
}
```

---

## 6. Internationalization (i18n)

### 6.1 Multi-Locale Strategy

- **Day 1 locales:** Hebrew (`he`), English (`en`), Arabic (`ar`)
- **RTL support:** Full BiDi text rendering in PWA and RN
- **Mapbox labels:** `localIdeographFontFamily` + language filter on style layers
- **Google Places:** `language` param per request, matched to user locale
- **Bot messages:** Locale detection from WhatsApp user profile language

### 6.2 RTL Considerations

- CSS `direction: rtl` on root container when `he` or `ar`
- Mapbox popup anchoring: mirror horizontal offset for RTL
- Venue list: right-aligned text, left-aligned distance badges

---

## 7. Privacy & Security

| Concern | Mitigation |
|---------|-----------|
| Location data | Stored only for session duration; purged on expiry/completion |
| Phone numbers | SHA-256 hashed; never stored in plaintext |
| Firebase rules | Per-participant write scoping; server-only centroid writes |
| HTTPS | Enforced end-to-end (Cloud Run default) |
| Session TTL | Default 4 hours; configurable per session |
| Rate limiting | FastAPI middleware: 60 req/min per IP |
| GDPR/Privacy | No persistent PII; session data auto-deleted |

---

## 8. Performance Targets

| Metric | Target |
|--------|--------|
| Midpoint computation | < 50ms (server-side) |
| POI fetch + ranking | < 800ms (including Google Places API) |
| Location sync latency | < 500ms (Firebase RTDB) |
| PWA first contentful paint | < 1.5s |
| Map tile load (Mapbox) | < 2s on 3G |
| Cold start (Cloud Run) | < 3s |
| Concurrent sessions | 10,000+ (Cloud Run auto-scaling) |

---

## 9. Tech Stack Summary

```
Frontend (PWA):     React 18 + Vite + Mapbox GL JS 3.x + i18next
Mobile:             React Native + Expo (dev builds) + @rnmapbox/maps
Backend:            Python 3.12 + FastAPI + geographiclib + httpx
Database:           Cloud SQL PostgreSQL 15 + PostGIS 3.4
Real-time:          Firebase Realtime Database
POI:                Google Places API (New)
Bot:                WhatsApp Business Cloud API
Hosting:            GCP Cloud Run + Firebase Hosting (PWA)
CI/CD:              GitHub Actions + EAS Build (mobile)
Monitoring:         Cloud Logging + Cloud Trace + Sentry
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Pre-development. Only `spec.md` and `plan.md` exist. No code has been written yet.

## What This Is

**Meet Me Halfway** is a geospatial app that computes a fair meeting point (geodesic centroid) between 2–5 participants and recommends ranked POIs at that midpoint. Distribution is via WhatsApp Business API bot + PWA share links.

## Architecture

**Monorepo** with these planned components:

- **Backend:** Python 3.12 + FastAPI on GCP Cloud Run
- **PWA:** React 18 + Vite + Mapbox GL JS 3.x
- **Mobile:** React Native + Expo (dev builds) + @rnmapbox/maps
- **Real-time:** Firebase Realtime Database (location sync, session state)
- **Spatial DB:** Cloud SQL PostgreSQL 15 + PostGIS 3.4
- **Bot:** WhatsApp Business Cloud API webhook
- **POI:** Google Places API (New)

## Core Spatial Logic

The midpoint algorithm lives in `midpoint.py` (Sprint 0 deliverable):

1. Convert participant `(lat, lng)` to ECEF Cartesian
2. Arithmetic mean of ECEF vectors → convert back to geodetic
3. For N=2: direct geodesic midpoint via `Geodesic.WGS84.Inverse()` + `.Direct()` at half-distance
4. Library: `geographiclib` (Karney algorithm, sub-meter accuracy)

**CRS: WGS84 (EPSG:4326) everywhere** — no projections, no transformations. GeoJSON uses `[lng, lat]` order.

POI search radius: `max(500, min(5000, max_pairwise_distance / 4))` meters.

POI ranking: `0.40×rating_norm + 0.30×distance_penalty + 0.20×popularity_norm + 0.10×open_now_bonus`

## Key API Endpoints

```
POST   /api/v1/sessions
GET    /api/v1/sessions/{id}
POST   /api/v1/sessions/{id}/join
PUT    /api/v1/sessions/{id}/location
GET    /api/v1/sessions/{id}/midpoint   ← main endpoint: returns centroid + ranked venues
POST   /api/v1/sessions/{id}/vote
DELETE /api/v1/sessions/{id}
```

## Database

**PostGIS tables:** `sessions`, `participants`, `selected_venues` — see `spec.md §4.1` for full schema.

**Firebase RTDB structure:** `/sessions/{session_id}/participants/{participant_id}` with `lat`, `lng`, `updated_at`. Centroid is server-written only (enforced by security rules).

## Testing

- Backend: pytest
- PWA E2E: Playwright
- Mobile E2E: Detox
- Load testing: k6 or Locust
- Coverage targets: ≥80% backend, ≥70% frontend

Spatial algorithm accuracy requirement: <1m error vs known geodesic midpoints.

## i18n

Day-1 locales: `he` (Hebrew), `en` (English), `ar` (Arabic). Full RTL support required. Use CSS logical properties for RTL-safe layout.

## Sprint Order (Critical Path)

Sprint 0 (spatial algo + FastAPI scaffold) → Sprint 1 (session API) → Sprint 2 (Google Places + POI ranking) → Sprint 3 (PWA) → Sprint 7 (hardening/launch). WhatsApp bot (Sprint 4) and mobile (Sprint 5) are parallel tracks.

## Code Style

- Output only technical solution/code, no filler
- Use type hints, docstrings, modular functions
- Never explain basic Python
- Never use deprecated functions — Shapely 2.0 vectorized ops, current PySAL submodules
- Prefer vectorized operations over `.apply()` or `iterrows()`
- Comments only for CRS warnings or spatial edge cases
- Verify CRS and check for invalid geometries before any spatial operation

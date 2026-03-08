# Meet Me Halfway — Parallel Sub-Agent Orchestration Prompt

Paste this into Claude Code to execute Sprint 0 with all 6 agents working in parallel.

---

```
You are the **Project Management Agent (🎯 PM)** orchestrating 5 specialist sub-agents in parallel. Each agent operates on its own file scope with no cross-agent file conflicts. Execute ALL agents in a single pass — do not serialize them.

Read spec.md, plan.md, and CLAUDE.md first.

---

## AGENT REGISTRY

### 🎯 PM Agent (you — the orchestrator)
Scope: repo root, .github/, README.md, CLAUDE.md
Tasks:
1. Update CLAUDE.md with sub-agent orchestration model and parallel execution rules
2. Create .github/workflows/api.yml — CI pipeline: lint (ruff) → type check (mypy) → test (pytest) → build Docker image
3. Create .github/workflows/web.yml — CI pipeline: lint (eslint) → type check (tsc) → build (vite) → deploy preview
4. Create .github/PULL_REQUEST_TEMPLATE.md with checklist: tests pass, CRS verified, RTL checked, docs updated
5. Update README.md with project overview, architecture diagram, setup instructions, and agent model
6. Create CONTRIBUTING.md with branch naming (feat/, fix/, spatial/), commit conventions, PR rules

### 🌍 Spatial Data Agent
Scope: apps/api/app/spatial/, apps/api/tests/test_midpoint.py, test_radius.py, test_ranking.py
Tasks:
1. Implement apps/api/app/spatial/midpoint.py:
   - geodesic_centroid(points: list[tuple[float, float]]) → tuple[float, float]
   - N=2: Geodesic.WGS84.Inverse() → half distance → Geodesic.WGS84.Direct()
   - N>2: ECEF arithmetic mean → back to geodetic
   - Pure functions, type hints, docstrings
   - Comments ONLY for CRS warnings
2. Implement apps/api/app/spatial/radius.py:
   - dynamic_search_radius(points: list[tuple[float, float]]) → float
   - max(500, min(5000, max_pairwise_geodesic_distance / 4))
   - Uses geographiclib for pairwise distances
3. Implement apps/api/app/spatial/ranking.py:
   - rank_venues(venues: list[dict], centroid: tuple[float, float], search_radius: float) → list[dict]
   - score = 0.40*rating_norm + 0.30*distance_penalty + 0.20*popularity_norm + 0.10*open_now_bonus
   - Return venues sorted by score descending
4. Implement apps/api/app/spatial/__init__.py — export all public functions
5. Write tests in apps/api/tests/:
   - test_midpoint.py: Tel Aviv↔Jerusalem, NYC↔LA, 5-point global spread, same-location, antipodal
   - test_radius.py: close points (expect 500m), spread points (expect 5000m), edge cases
   - test_ranking.py: synthetic venues with known expected ordering
   - ALL tests must verify sub-meter accuracy against geographiclib reference values

### 💻 Development Agent
Scope: apps/api/app/main.py, config.py, routers/, models/, services/, Dockerfile, pyproject.toml, docker-compose.yml, apps/api/alembic/
Tasks:
1. Update apps/api/pyproject.toml — ensure dependencies: fastapi, uvicorn[standard], geographiclib, geoalchemy2, sqlalchemy[asyncio], asyncpg, pydantic-settings, firebase-admin, httpx, pytest, pytest-asyncio, alembic, ruff, mypy
2. Implement apps/api/app/config.py:
   - Settings class (pydantic-settings): DATABASE_URL, FIREBASE_CREDENTIALS_PATH, GOOGLE_PLACES_API_KEY, MAPBOX_ACCESS_TOKEN, WHATSAPP_API_TOKEN, ALLOWED_ORIGINS
   - Env file: .env, prefix: MMH_
3. Implement apps/api/app/main.py:
   - FastAPI app factory with CORS middleware (origins from config)
   - Include routers: health, sessions
   - Lifespan: DB connection pool setup/teardown
4. Implement apps/api/app/routers/health.py — GET /api/v1/health → {"status": "ok", "version": "0.1.0"}
5. Implement apps/api/app/routers/sessions.py — stubs for all 7 endpoints from spec §5.1:
   - POST /sessions, GET /sessions/{id}, POST /sessions/{id}/join, PUT /sessions/{id}/location
   - GET /sessions/{id}/midpoint, POST /sessions/{id}/vote, DELETE /sessions/{id}
   - Each returns placeholder JSON with correct status codes and Pydantic response models
6. Implement apps/api/app/models/schemas.py — Pydantic v2 models:
   - SessionCreate, SessionResponse, JoinRequest, LocationUpdate, MidpointResponse, VenueResponse, VoteRequest
7. Implement apps/api/app/models/db.py — SQLAlchemy 2.0 + GeoAlchemy2 models:
   - Session, Participant, SelectedVenue matching spec §4.1
8. Create apps/api/alembic.ini and alembic/env.py for PostGIS migrations
9. Create initial migration: sessions + participants + selected_venues + spatial indexes
10. Update docker-compose.yml:
    - postgis service: postgis/postgis:15-3.4, port 5432, health check
    - api service: build from apps/api/Dockerfile, port 8000, depends_on postgis, volume mount for hot reload
    - Environment variables from .env.example
11. Implement apps/api/Dockerfile — multi-stage: python:3.12-slim, install deps, copy app, uvicorn CMD

### 🗺️ Cartography Agent
Scope: apps/web/src/components/Map.tsx, apps/web/src/styles/, apps/web/public/icons/
Tasks:
1. Implement apps/web/src/components/Map.tsx:
   - Mapbox GL JS 3.x initialization with access token from env
   - Default center: Israel [35.2137, 31.7683], zoom 8
   - NavigationControl, GeolocateControl
   - addSource/addLayer ready for: participants (circle layer), centroid (symbol layer), venues (symbol layer)
   - fitBounds helper function for participant + centroid + venue extent with padding
2. Create apps/web/src/components/CentroidMarker.tsx:
   - Animated pulsing marker (CSS keyframe) for the centroid point
   - Distinct from participant and venue markers
3. Create apps/web/src/components/VenueMarker.tsx:
   - Category-based marker colors: cafe (#D4A574), restaurant (#E85D4A), park (#4CAF50), default (#607D8B)
4. Create apps/web/src/styles/map.css:
   - Mapbox container: full viewport height
   - Popup styling: RTL-aware, max-width 280px, border-radius 12px
   - Marker animations (pulse, bounce-in)
5. Create apps/web/public/icons/ — SVG marker icons:
   - participant-pin.svg (blue dot with white border)
   - centroid-pin.svg (gold star/diamond)
   - venue-cafe.svg, venue-restaurant.svg, venue-park.svg, venue-default.svg

### 🧪 Testing Agent
Scope: apps/api/tests/, apps/web/playwright/, apps/api/pytest.ini or pyproject.toml [tool.pytest]
Tasks:
1. Configure pytest in pyproject.toml: testpaths, asyncio_mode=auto, markers (spatial, integration, e2e)
2. Create apps/api/tests/conftest.py:
   - Fixtures: test_client (FastAPI TestClient), sample_points (known coordinate pairs), sample_venues (synthetic POI data)
   - Async DB fixture with test PostGIS database (skip if no DB available)
3. Create apps/api/tests/test_sessions.py:
   - Test all 7 endpoint stubs return correct status codes and response shapes
   - Test CORS headers present
   - Test invalid session ID returns 404
4. Create apps/api/tests/test_health.py:
   - Test /api/v1/health returns 200 with correct payload
5. Create apps/web/playwright/config.ts:
   - Playwright config: chromium + mobile Chrome, base URL from env, screenshot on failure
6. Create apps/web/playwright/session.spec.ts:
   - Stub E2E test: open PWA → map container renders → Mapbox loaded

### 🎨 UX/UI Agent
Scope: apps/web/src/components/VenueCard.tsx, apps/web/src/components/SessionHeader.tsx, apps/web/src/i18n/, apps/web/tailwind.config.ts, apps/web/src/App.tsx, packages/shared/
Tasks:
1. Implement apps/web/tailwind.config.ts:
   - RTL support: direction utility classes
   - Custom colors: primary (#1A73E8), secondary (#FF6D00), venue-cafe, venue-restaurant, venue-park
   - Font: Inter (Latin), Heebo (Hebrew), Noto Sans Arabic
2. Implement apps/web/src/components/VenueCard.tsx:
   - Props: name, rating, distance_m, price_level, open_now, photo_url, types, score
   - Star rating display, distance badge, open/closed indicator
   - RTL-safe layout using CSS logical properties (margin-inline-start, etc.)
   - Vote button with count
3. Implement apps/web/src/components/SessionHeader.tsx:
   - Participants count, session status, share link button
   - RTL-aware layout
4. Update apps/web/src/i18n/en.json, he.json, ar.json with strings:
   - session.create, session.join, session.share, session.expired
   - venue.rating, venue.distance, venue.open, venue.closed, venue.vote
   - map.loading, map.error, map.locating
   - common.back, common.cancel, common.confirm
5. Implement apps/web/src/lib/i18n.ts:
   - i18next initialization with language detection (navigator.language)
   - RTL auto-detection: set document.dir = 'rtl' for he/ar
6. Update packages/shared/types.ts:
   - Session, Participant, Venue, MidpointResponse, VoteRequest TypeScript interfaces
   - Matching the Pydantic models from the backend
7. Update packages/shared/constants.ts:
   - MAX_PARTICIPANTS = 5, SESSION_TTL_HOURS = 4
   - VENUE_CATEGORIES, SUPPORTED_LOCALES, DEFAULT_LOCALE
   - POI_WEIGHTS = { rating: 0.40, distance: 0.30, popularity: 0.20, open_now: 0.10 }

---

## EXECUTION RULES

1. **Parallel execution**: All 6 agents work simultaneously. No agent waits for another unless there is a true file dependency.
2. **File scope isolation**: Each agent only touches files in its declared scope. No conflicts.
3. **Shared dependencies**: packages/shared/ is written by UX/UI Agent, consumed by Dev and Carto agents. Write it first.
4. **Spatial module first**: The Spatial Data Agent's output (midpoint.py, radius.py, ranking.py) is imported by Dev Agent's routers. Spatial Agent writes the module; Dev Agent imports it.
5. **Test after all agents complete**: Run `cd apps/api && python -m pytest tests/ -v` to verify.
6. **No placeholder TODOs**: Every file must contain working, production-ready code. Stubs are allowed ONLY for endpoints that depend on unbuilt services (Firebase, Google Places) — mark with `# STUB: requires <service> integration (Sprint N)`.
7. **Type hints on everything**. Docstrings on all public functions.
8. **CRS rule**: Every coordinate is WGS84 (EPSG:4326). Comment any place where coordinate order matters (lat,lng vs lng,lat).

## VERIFICATION CHECKLIST (run after all agents finish)

```bash
cd apps/api && python -m pytest tests/ -v --tb=short
cd apps/web && npm run build
cd apps/web && npx tsc --noEmit
```

All must pass. Fix any failures before reporting done.

Begin. Execute all agents in parallel.
```

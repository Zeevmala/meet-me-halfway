# Meet Me Halfway — Project Plan

**Version:** 1.0.0-draft
**Date:** 2026-03-07
**Methodology:** Agile (2-week sprints)
**Duration:** 16 weeks (8 sprints)
**Launch Target:** Week 16

---

## 1. Sub-Agent Orchestration Model

The project is orchestrated through six specialized sub-agents, each owning a domain. The **Project Management Agent** coordinates all others.

```
                    ┌─────────────────────┐
                    │   🎯 PROJECT MGMT   │
                    │   Agent (PM)        │
                    │   Sprint planning   │
                    │   Risk management   │
                    │   Cross-agent sync  │
                    └─────────┬───────────┘
                              │
        ┌─────────┬──────────┼──────────┬──────────┐
        ▼         ▼          ▼          ▼          ▼
  ┌───────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ ┌─────────┐
  │🌍 SPATIAL │ │💻 DEV    │ │🗺️ CARTO│ │🧪 TEST │ │🎨 UX/UI │
  │DATA Agent │ │Agent     │ │Agent   │ │Agent   │ │Agent    │
  │           │ │          │ │        │ │        │ │         │
  │Algorithms │ │Frontend  │ │Basemap │ │Unit    │ │Wireframe│
  │PostGIS    │ │Backend   │ │Styling │ │Integr. │ │Prototyp │
  │CRS/Geom   │ │Infra     │ │Markers │ │E2E     │ │RTL/i18n │
  │GeoPandas  │ │Firebase  │ │Popups  │ │Spatial │ │A11y     │
  └───────────┘ └──────────┘ └────────┘ └────────┘ └─────────┘
```

### 1.1 Agent Responsibilities

#### 🎯 Project Management Agent
- Sprint planning, backlog grooming, velocity tracking
- Cross-agent dependency resolution
- Risk register maintenance
- Stakeholder reporting
- Definition of Done enforcement

#### 🌍 Spatial Data Agent
- Geodesic centroid algorithm (Karney/geographiclib)
- PostGIS schema design and spatial indexing
- POI search radius calculation
- POI ranking formula tuning
- CRS validation (WGS84 throughout)
- Geometry validation pipelines
- Benchmark verification against Rey et al., Tenkanen et al.

#### 💻 Development Agent
- FastAPI backend scaffolding and API endpoints
- React PWA + React Native app
- Firebase RTDB integration and security rules
- WhatsApp Business API bot webhook
- Cloud Run deployment and CI/CD
- Google Places API integration

#### 🗺️ Cartography Agent
- Mapbox custom style (light/dark themes)
- Marker and icon design (participant pins, centroid marker, venue markers)
- Popup/card design for venue info
- Map interaction patterns (bounds fitting, animation)
- Locale-aware map labels (Hebrew, Arabic, English)
- Isochrone visualization (future: v2)

#### 🧪 Testing Agent
- Unit tests: spatial algorithm accuracy (sub-meter verification)
- Integration tests: API endpoints, Firebase sync
- E2E tests: full session lifecycle (Playwright for PWA, Detox for RN)
- Spatial edge cases: antipodal points, poles, dateline crossing
- Load testing: 10K concurrent sessions (k6/Locust)
- Accessibility audit (WCAG 2.1 AA)

#### 🎨 UX/UI Agent
- Wireframes and interactive prototypes (Figma)
- WhatsApp bot conversation flow design
- PWA responsive layout (mobile-first)
- RTL layout mirroring for Hebrew/Arabic
- Venue card component design
- Voting UI/UX
- Onboarding flow (permission prompts, location sharing consent)
- Motion design (centroid animation, participant join)

---

## 2. Sprint Plan

### Sprint 0 — Foundation (Weeks 1–2)

**Goal:** Project scaffold, dev environment, spatial algorithm proof-of-concept

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 🎯 PM | Repo setup, CI/CD skeleton, sprint board | GitHub repo, GH Actions config, Jira/Linear board |
| 🌍 Spatial | Geodesic centroid algorithm + unit tests | `midpoint.py` module with Karney impl, test suite |
| 💻 Dev | FastAPI project scaffold, Cloud SQL + PostGIS provisioning | `/api/v1/health` endpoint live on Cloud Run |
| 💻 Dev | Firebase project setup, RTDB rules | Firebase config, security rules deployed |
| 🗺️ Carto | Mapbox Studio style: base theme (light) | Style URL published |
| 🎨 UX/UI | Wireframes: session flow (create → join → midpoint → venue) | Figma file, 5 key screens |
| 🧪 Test | Test framework setup (pytest, Playwright, Detox) | CI test pipeline running |

**Definition of Done:** Centroid algorithm passes accuracy tests (< 1m error vs known geodesic midpoints). FastAPI serves health check on Cloud Run.

---

### Sprint 1 — Core Session Lifecycle (Weeks 3–4)

**Goal:** Create session → join → compute midpoint → return result

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 🌍 Spatial | PostGIS schema migration, spatial index tuning | Alembic migration, `sessions` + `participants` tables |
| 🌍 Spatial | Dynamic search radius algorithm | `search_radius()` function with tests |
| 💻 Dev | Session CRUD endpoints (create, join, get) | 4 API endpoints with OpenAPI docs |
| 💻 Dev | Midpoint endpoint: calls spatial module → returns centroid | `/midpoint` returns JSON with centroid |
| 💻 Dev | Firebase RTDB: write participant locations, sync centroid | Real-time location flow working |
| 🎨 UX/UI | Refine wireframes based on Sprint 0 feedback | Updated Figma, component specs |
| 🧪 Test | API integration tests (session lifecycle) | pytest suite, 90%+ coverage on endpoints |

**Definition of Done:** Full session lifecycle works via API: create → join (3 participants) → midpoint returned with correct centroid.

---

### Sprint 2 — Google Places + POI Ranking (Weeks 5–6)

**Goal:** Midpoint returns ranked, relevant venues

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 🌍 Spatial | POI ranking formula implementation + tuning | `rank_venues()` module with configurable weights |
| 💻 Dev | Google Places API integration (Nearby Search + Details) | Places proxy endpoint with caching |
| 💻 Dev | Venue voting endpoint | `/vote` endpoint, Firebase vote sync |
| 💻 Dev | Places response caching (Redis or in-memory TTL) | Cache layer reducing Places API calls by 60%+ |
| 🗺️ Carto | Venue marker icons (category-based: cafe, restaurant, park) | SVG icon set, Mapbox symbol layer config |
| 🎨 UX/UI | Venue card component design (rating, distance, photo, hours) | Figma component, responsive specs |
| 🧪 Test | POI ranking accuracy tests (synthetic scenarios) | Test suite with 10+ ranked scenarios |

**Definition of Done:** `/midpoint` returns top 10 ranked venues with scores. Ranking verified against manual evaluation.

---

### Sprint 3 — PWA Map Interface (Weeks 7–8)

**Goal:** Functional web app: view participants, centroid, venues on map

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 💻 Dev | React PWA scaffold (Vite + Mapbox GL JS) | PWA shell with map rendering |
| 💻 Dev | Firebase listener: real-time participant pins on map | Live location dots updating |
| 💻 Dev | Centroid display + venue markers on map | Midpoint marker + venue pins |
| 💻 Dev | Venue detail panel (bottom sheet / sidebar) | Tappable venue cards with Google Places data |
| 🗺️ Carto | Map bounds fitting (all participants + centroid + venues) | `fitBounds` with padding logic |
| 🗺️ Carto | Centroid animation (pulse/glow marker) | Animated centroid marker |
| 🎨 UX/UI | PWA responsive layout implementation review | Layout QA pass, RTL toggle |
| 🧪 Test | Playwright E2E: open link → see map → see venues | 3 E2E scenarios passing |

**Definition of Done:** User opens PWA link → sees participants on map → centroid appears → venue cards displayed. Works on Chrome mobile.

---

### Sprint 4 — WhatsApp Bot Integration (Weeks 9–10)

**Goal:** Full WhatsApp flow: bot creates session, shares link, notifies

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 💻 Dev | WhatsApp Business API webhook handler | Webhook endpoint, message parsing |
| 💻 Dev | Bot conversation flow: `/meetme` → creates session → shares link | Bot responds with session link |
| 💻 Dev | Bot notifications: "X joined", "midpoint ready", "venue selected" | Push notifications via WA API |
| 💻 Dev | Deep link generation (PWA URL with session token) | Secure, expiring share links |
| 🎨 UX/UI | Bot message templates (Hebrew, English, Arabic) | i18n message catalog |
| 🎨 UX/UI | WhatsApp link preview card (OG meta tags) | PWA meta tags for rich preview |
| 🧪 Test | Bot E2E: send command → receive link → open PWA | Integration test with WA API sandbox |

**Definition of Done:** User sends `/meetme` in WhatsApp → receives link → shares with friends → friends open PWA and see the map.

---

### Sprint 5 — React Native Mobile App (Weeks 11–12)

**Goal:** Native iOS/Android app with feature parity to PWA

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 💻 Dev | Expo project init (dev build config for @rnmapbox/maps) | EAS Build config, dev builds for iOS + Android |
| 💻 Dev | Map screen with Mapbox RN SDK | Native map rendering with participant pins |
| 💻 Dev | Firebase RN SDK integration (real-time location sync) | Live location updates on native |
| 💻 Dev | Venue list + detail screens | Native venue cards |
| 💻 Dev | Background location (Expo Location task) | Location updates when app backgrounded |
| 🗺️ Carto | Mobile-optimized markers (density, tap targets) | 44px minimum tap targets, cluster at zoom < 12 |
| 🎨 UX/UI | Native navigation patterns (bottom sheet, haptics) | Platform-specific UX review |
| 🧪 Test | Detox E2E: session join → map → venue selection | iOS + Android test suites |

**Definition of Done:** Mobile app installable via EAS, full session flow works on both platforms.

---

### Sprint 6 — i18n, RTL, Polish (Weeks 13–14)

**Goal:** Production-quality multi-locale experience

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 💻 Dev | i18next integration (PWA + RN) with `he`, `en`, `ar` | Full string externalization |
| 💻 Dev | RTL layout mirroring (CSS logical properties, RN I18nManager) | All screens correct in RTL |
| 🗺️ Carto | Mapbox locale-aware labels (Hebrew/Arabic map text) | Language-filtered style layers |
| 🗺️ Carto | Dark mode map style | Secondary Mapbox style |
| 🎨 UX/UI | RTL visual QA: popups, cards, navigation | RTL screenshot audit |
| 🎨 UX/UI | Accessibility audit (screen readers, color contrast) | WCAG 2.1 AA compliance report |
| 🧪 Test | i18n test matrix: 3 locales × 3 platforms | Cross-locale E2E pass |
| 🧪 Test | Performance profiling (Lighthouse, React profiler) | Performance report with fixes |

**Definition of Done:** All 3 locales render correctly on web + iOS + Android. Lighthouse PWA score ≥ 90.

---

### Sprint 7 — Hardening, Load Testing, Launch Prep (Weeks 15–16)

**Goal:** Production readiness, monitoring, launch

| Agent | Tasks | Deliverables |
|-------|-------|-------------|
| 🎯 PM | Launch checklist, rollback plan, monitoring dashboard | Go/no-go document |
| 💻 Dev | Cloud Run production config (min instances, concurrency) | Terraform/gcloud deploy scripts |
| 💻 Dev | Rate limiting, error handling, graceful degradation | Middleware hardened |
| 💻 Dev | Monitoring: Cloud Logging, Cloud Trace, Sentry | Alerts configured |
| 💻 Dev | Session cleanup cron (expire + purge old data) | Cloud Scheduler job |
| 🌍 Spatial | Edge case hardening: antipodal, single participant, same location | Spatial edge case suite passing |
| 🧪 Test | Load test: 10K concurrent sessions (k6 / Locust) | Load test report, bottleneck analysis |
| 🧪 Test | Security review: Firebase rules, API auth, input validation | Security audit report |
| 🧪 Test | Full regression: all E2E suites green | Release candidate sign-off |
| 🎨 UX/UI | Final polish pass: animations, micro-interactions | Ship-ready UI |

**Definition of Done:** All tests green. Load test passes 10K sessions. Monitoring active. WhatsApp bot live.

---

## 3. Risk Register

| # | Risk | Probability | Impact | Mitigation | Owner |
|---|------|------------|--------|------------|-------|
| R1 | Google Places API rate limits / cost overrun | Medium | High | Response caching (5-min TTL), request batching, budget alerts | 💻 Dev |
| R2 | WhatsApp Business API approval delay | Medium | High | Start approval process Sprint 0; PWA-only fallback | 🎯 PM |
| R3 | Firebase RTDB hotspot on popular sessions | Low | Medium | Sharding by session prefix, RTDB fan-out rules | 💻 Dev |
| R4 | Geodesic centroid edge cases (antipodal, polar) | Low | Medium | Comprehensive edge case test suite, fallback to geometric mean | 🌍 Spatial |
| R5 | Mapbox RN SDK build issues with Expo | Medium | Medium | Pin SDK versions, EAS custom dev client, fallback to MapLibre RN | 💻 Dev |
| R6 | RTL layout regressions across platforms | Medium | Low | Automated screenshot comparison (Percy/Chromatic) | 🧪 Test |
| R7 | Cloud Run cold start latency | Low | Low | Min instances = 1 in production, lazy-load heavy modules | 💻 Dev |

---

## 4. Dependency Graph

```
Sprint 0 ──┬── Sprint 1 ──┬── Sprint 2 ──── Sprint 3 ──┬── Sprint 5
            │              │                             │
            │              └── Sprint 4 ─────────────────┤
            │                                            │
            └──────────────────────────── Sprint 6 ──── Sprint 7
```

**Critical path:** Sprint 0 → 1 → 2 → 3 → 7 (spatial algorithm → API → POI → PWA → launch)

**Parallel tracks:**
- WhatsApp bot (Sprint 4) can develop in parallel after Sprint 1
- Mobile app (Sprint 5) can start after Sprint 3 PWA stabilizes
- i18n (Sprint 6) runs parallel to Sprint 5

---

## 5. Definition of Done (Global)

Every deliverable must satisfy:

- Code reviewed by ≥ 1 peer (PR approval required)
- Unit test coverage ≥ 80% for backend, ≥ 70% for frontend
- Spatial algorithms verified against benchmark resources
- No critical/high Sentry errors in staging for 48 hours
- Lighthouse performance score ≥ 90 (PWA)
- RTL layout verified for Hebrew and Arabic
- API documentation updated (OpenAPI spec)
- Firebase security rules tested with emulator

---

## 6. Tools & Infrastructure

| Category | Tool |
|----------|------|
| Version Control | GitHub (monorepo) |
| CI/CD | GitHub Actions + EAS Build |
| Project Board | Linear or GitHub Projects |
| Design | Figma |
| API Docs | FastAPI auto-generated OpenAPI + Swagger UI |
| Monitoring | GCP Cloud Logging + Cloud Trace + Sentry |
| Load Testing | k6 (scripted) or Locust (Python) |
| E2E Testing | Playwright (web) + Detox (mobile) |
| Infrastructure | Terraform (GCP resources) |
| Secrets | GCP Secret Manager |

---

## 7. Cost Estimation (Monthly, Post-Launch)

| Service | Estimated Cost | Notes |
|---------|---------------|-------|
| Cloud Run | $50–150 | Auto-scaling, min 1 instance |
| Cloud SQL (PostGIS) | $30–80 | db-f1-micro to db-g1-small |
| Firebase RTDB | $25–75 | Based on connections + data transfer |
| Google Places API | $200–500 | ~10K sessions/mo × 3 Place Detail calls |
| Mapbox | $0–50 | Free tier covers 50K map loads |
| WhatsApp Business API | $0–100 | Per-conversation pricing |
| **Total** | **$305–955/mo** | Scales with usage |

---

## 8. Post-v1 Roadmap (v2+)

| Feature | Agent | Sprint |
|---------|-------|--------|
| Isochrone-weighted midpoint (travel-time fairness) | 🌍 Spatial | v2 |
| Directions integration (Mapbox Directions API) | 🗺️ Carto | v2 |
| Venue category filters (café, park, restaurant) | 🎨 UX/UI | v2 |
| Session history and favorites | 💻 Dev | v2 |
| Telegram bot integration | 💻 Dev | v2 |
| Network-based midpoint (OSRM/Valhalla) | 🌍 Spatial | v3 |
| Multi-modal transport weighting | 🌍 Spatial | v3 |
| AR venue preview | 🎨 UX/UI | v3 |

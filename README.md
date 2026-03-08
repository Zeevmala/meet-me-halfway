# Meet Me Halfway

A geospatial app that computes a fair meeting point (geodesic centroid) between 2-5 participants and recommends ranked POIs at that midpoint. Distributed via WhatsApp bot, PWA, and React Native mobile app.

## Architecture

```
                        ┌──────────────┐
                        │   WhatsApp   │
                        │   Business   │
                        │   Cloud API  │
                        └──────┬───────┘
                               │ webhook
┌─────────────┐  ┌─────────────▼──────────────┐  ┌─────────────┐
│  PWA        │  │       FastAPI (Cloud Run)   │  │  Mobile     │
│  React 18   │──│                             │──│  Expo/RN    │
│  Vite       │  │  Spatial: geographiclib     │  │  @rnmapbox  │
│  Mapbox GL  │  │  ORM:    SQLAlchemy 2.0     │  │             │
└──────┬──────┘  └──┬─────────┬────────────┬───┘  └──────┬──────┘
       │            │         │            │             │
       │     ┌──────▼──────┐  │  ┌─────────▼──────────┐  │
       │     │ Cloud SQL   │  │  │ Google Places API  │  │
       │     │ PostgreSQL  │  │  │ (New) — POI search │  │
       │     │ + PostGIS   │  │  └────────────────────┘  │
       │     └─────────────┘  │                          │
       │                ┌─────▼─────────────┐            │
       └────────────────│ Firebase RTDB     │────────────┘
                        │ (real-time sync)  │
                        └───────────────────┘
```

**CRS: WGS84 (EPSG:4326) everywhere.** GeoJSON uses `[lng, lat]` order.

## Project Structure

```
meet-me-halfway/
├── apps/
│   ├── api/          # Python 3.12 + FastAPI backend
│   │   ├── app/
│   │   │   ├── spatial/      # Geodesic centroid (geographiclib)
│   │   │   ├── services/     # Session, Firebase, Places, cache
│   │   │   ├── routers/      # health, sessions, webhook
│   │   │   ├── middleware/    # logging, rate_limit, UUID validation
│   │   │   ├── models/       # SQLAlchemy ORM + Pydantic schemas
│   │   │   ├── tasks/        # Background cleanup
│   │   │   └── bot/          # WhatsApp client + i18n messages
│   │   └── tests/
│   ├── web/          # React 18 + Vite PWA
│   │   └── src/
│   │       ├── components/   # Map, VenueList, VenueCard, etc.
│   │       ├── hooks/        # useSession, useFirebase
│   │       └── i18n/         # en, he, ar translations
│   └── mobile/       # Expo 51 + React Native
│       ├── app/              # expo-router file-based nav
│       ├── hooks/            # useSession, useFirebase, useLocation
│       └── i18n/             # en, he, ar translations
├── packages/
│   └── shared/       # TypeScript types + constants
├── infra/
│   ├── terraform/    # GCP Cloud Run + Cloud SQL + Secrets
│   ├── database.rules.json   # Firebase RTDB security rules
│   └── firebase.json         # Firebase Hosting config
└── .github/workflows/        # CI: api.yml, web.yml
```

## Quick Start

### Prerequisites
- Python 3.12+
- Node 20+
- Docker + Docker Compose

### Full Stack (Docker)

```bash
cp .env.example .env
# Edit .env with your API keys (Mapbox, Firebase, Google Places)

docker compose up --build
# API:  http://localhost:8000
# PWA:  http://localhost:5173
```

### Backend Only

```bash
cd apps/api
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

### PWA Only

```bash
cd apps/web
npm install
npm run dev
```

### Mobile

```bash
cd apps/mobile
npm install
npx expo start
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Basic health check |
| `GET` | `/api/v1/health` | Detailed health (DB + Firebase status) |
| `POST` | `/api/v1/sessions` | Create session |
| `GET` | `/api/v1/sessions/{id}` | Get session details |
| `POST` | `/api/v1/sessions/{id}/join` | Join with name + location |
| `PUT` | `/api/v1/sessions/{id}/location` | Update participant location |
| `GET` | `/api/v1/sessions/{id}/midpoint` | Compute centroid + ranked venues |
| `POST` | `/api/v1/sessions/{id}/vote` | Vote for a venue |
| `DELETE` | `/api/v1/sessions/{id}` | End session |
| `GET` | `/api/v1/webhook` | WhatsApp verification |
| `POST` | `/api/v1/webhook` | WhatsApp inbound messages |

## Testing

```bash
# Backend tests (89+ tests)
cd apps/api
python -m pytest tests/ -v

# Spatial algorithm accuracy
python -c "
from app.spatial.midpoint import geodesic_centroid
r = geodesic_centroid([(32.0853, 34.7818), (31.7683, 35.2137)])
print('Midpoint:', r)
"

# PWA typecheck + build
cd apps/web
npx tsc --noEmit && npm run build

# Load test (requires running API)
cd apps/api
python -m locust -f tests/load/locustfile.py --headless -u 10 -r 2 -t 10s --host http://localhost:8000
```

## Midpoint Algorithm

1. Convert participant `(lat, lng)` to ECEF Cartesian coordinates
2. Arithmetic mean of ECEF vectors
3. Convert back to geodetic `(lat, lng)`
4. For N=2: direct geodesic midpoint via Karney algorithm (sub-meter accuracy)

POI search radius: `max(500, min(5000, max_pairwise_distance / 4))` meters.

POI ranking formula: `0.40 * rating + 0.30 * distance_penalty + 0.20 * popularity + 0.10 * open_now_bonus`

## i18n

Day-1 locales: English (`en`), Hebrew (`he`), Arabic (`ar`). Full RTL support with CSS logical properties.

## Database Migrations

```bash
docker compose up db -d
cd apps/api
alembic upgrade head
```

## Infrastructure

Terraform configs in `infra/terraform/` for GCP deployment:
- Cloud Run (min 2 instances, 512Mi)
- Cloud SQL PostgreSQL 15 + PostGIS
- Secret Manager for credentials
- IAM with minimal roles

```bash
cd infra/terraform
terraform init
terraform plan -var="project_id=your-project" -var="db_password=secret"
terraform apply
```

## License

Private — all rights reserved.

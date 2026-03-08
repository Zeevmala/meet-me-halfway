# Contributing to Meet Me Halfway

## Branch Naming

| Prefix | Use |
|--------|-----|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `spatial/` | Spatial algorithm or CRS change |
| `refactor/` | No behavior change |
| `test/` | Tests only |
| `chore/` | Build, deps, CI |

Examples: `feat/session-api`, `spatial/ecef-centroid`, `fix/rtl-venue-card`

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `spatial`, `refactor`, `test`, `chore`, `docs`
Scopes: `api`, `web`, `mobile`, `spatial`, `db`, `ci`, `i18n`

Examples:
```
feat(api): implement session join endpoint
spatial(midpoint): switch N≥3 to ECEF arithmetic mean
fix(web): use logical CSS props for RTL venue card
```

## PR Rules

1. All CI checks must pass before merge
2. At least one reviewer approval required
3. Squash merge into `main`
4. Delete branch after merge

## Spatial Code Rules

- **CRS: WGS84 (EPSG:4326) everywhere.** No projections, no transformations.
- Comment any function where coordinate order differs from `(lat, lng)` — GeoJSON uses `[lng, lat]`.
- Validate geometry before spatial ops. Guard against `None` locations.
- Test against known geodesic reference values. Accuracy target: < 1m error.
- Use `geographiclib` (Karney algorithm) for all geodesic calculations.

## Frontend / i18n Rules

- Use CSS logical properties: `margin-inline-start`, `padding-inline-end`, etc.
- Never hardcode `margin-left`, `margin-right`, `padding-left`, `padding-right`.
- Every user-visible string must have translations in `en.json`, `he.json`, `ar.json`.
- RTL layout tested with `he` and `ar` locales before merging.

## Dev Setup

```bash
# Backend
cd apps/api
pip install -e ".[dev]"
python -m pytest tests/ -v

# Frontend
cd apps/web
npm install
npm run dev

# Full stack
docker compose up --build
```

## Pre-commit Hooks

```bash
pip install pre-commit
pre-commit install
```

Hooks run automatically on `git commit`: ruff, mypy, eslint, prettier, file-size check.

## Summary

<!-- What does this PR do? One paragraph max. -->

## Type

- [ ] `feat/` — new feature
- [ ] `fix/` — bug fix
- [ ] `spatial/` — spatial algorithm change
- [ ] `refactor/` — no behavior change
- [ ] `test/` — tests only
- [ ] `chore/` — build, deps, CI

## Checklist

### All PRs
- [ ] Tests pass locally (`python -m pytest tests/ -v` and/or `npm run build`)
- [ ] No new linting errors (`ruff check` / `eslint`)
- [ ] Type checks pass (`mypy --strict apps/api/app/` / `tsc --noEmit`)

### Spatial changes
- [ ] CRS verified — all coordinates are WGS84 (EPSG:4326)
- [ ] Coordinate order documented where it matters (`lat,lng` vs `lng,lat`)
- [ ] Invalid geometry guard added before any spatial operation
- [ ] Accuracy tested against known geodesic reference values (< 1m error)

### Frontend changes
- [ ] RTL layout checked (`he` locale)
- [ ] CSS logical properties used (no `margin-left/right`, `padding-left/right`)
- [ ] i18n strings added to `en.json`, `he.json`

### Database changes
- [ ] Alembic migration created (`alembic revision -m "..."`)
- [ ] Migration tested: `alembic upgrade head` + `alembic downgrade -1`
- [ ] PostGIS extension assumed present (no raw SQL without `CREATE EXTENSION IF NOT EXISTS`)

## Testing

<!-- How was this tested? Commands run, environments used. -->

## Related

<!-- Closes #issue, links to spec section -->

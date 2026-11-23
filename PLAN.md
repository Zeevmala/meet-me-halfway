# Meet Me Halfway — Project Plan

## v1 MVP Status

| Phase | Status | Tests |
|-------|--------|-------|
| P0 — Core Real-time Flow | Done | 89 |
| P1 — Destination Features | Done | 103 |
| P2 — Robustness | Done | 147 |
| P3 — Declared Execution Graph | Done | 344 |

**Deployed:** [meet-me-halfway-4ae79.web.app](https://meet-me-halfway-4ae79.web.app)

## Remaining to Production

- [x] Error tracking (Sentry) — client-side exception capture
- [x] Rate limiting on client API calls — admission control, circuit breakers and
      backoff per node (see `ARCHITECTURE.md`)
- [x] E2E tests with Playwright — smoke coverage in `e2e/`, run in CI
- [x] Performance audit — Lighthouse runs in CI, accessibility gated at 0.9
- [x] Firebase RTDB security rules — published by the `deploy` job in
      `.github/workflows/web.yml`, in the same job as hosting, so the bundle and
      the rules can no longer reach production independently
- [x] Time-fair meeting point — minimax travel time over a Matrix API
      sample, shared through the session so every device routes to one place
- [x] Screen wake lock during a session; arrival shown per participant
- [ ] Custom domain + SSL
- [ ] Mapbox Matrix budget — an evaluation is two requests of
      participants × ~20 elements; watch usage against the plan's free tier
      before promoting the app
- [ ] Install prompt (Android `beforeinstallprompt`, iOS Add to Home Screen
      hint) and store listings (Play via Trusted Web Activity; iOS needs a
      native shell for background location)
- [ ] Route geometry: request `overview=simplified` for non-local slots — the
      last-known-good buffer doubles retained geometry, and full overview is
      ~150–400 KB per route

## v2 Roadmap

- [ ] WhatsApp bot for session creation and invites
- [ ] Transit/cycling travel profiles
- [ ] Session history and favorite venues
- [ ] Push notifications for partner arrival
- [ ] Shareable session summary (screenshot/link)

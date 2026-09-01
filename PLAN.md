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
- [ ] Firebase RTDB security rules: deploy via `firebase deploy --only database`
      (CI deploys hosting only)
- [ ] Custom domain + SSL
- [ ] Route geometry: request `overview=simplified` for non-local slots — the
      last-known-good buffer doubles retained geometry, and full overview is
      ~150–400 KB per route

## v2 Roadmap

- [ ] WhatsApp bot for session creation and invites
- [ ] Transit/cycling travel profiles
- [ ] Session history and favorite venues
- [ ] Push notifications for partner arrival
- [ ] Shareable session summary (screenshot/link)

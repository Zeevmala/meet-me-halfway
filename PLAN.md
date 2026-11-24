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
- [ ] Custom domain + SSL

## v2 Roadmap

- [ ] Meeting point balanced by travel time (Mapbox Matrix, minimax) — built
      behind `VITE_BALANCED_MEETING`, off: each device works out its own. Ships
      when the lowest counted slot computes it and the session reads it from
      the database (schema change by expand/contract; decide whether the point
      is cleared on disconnect, and say so in the privacy policy). Then: hold
      the previous point across a travel-mode toggle so a picked venue
      survives it
- [ ] Rank venues by the same matrix (fairness of the trip to each venue,
      not straight-line distance from the meeting point)
- [ ] One destination for the whole session: the picked venue and travel mode
      are per device today, so two people can navigate to different places
- [ ] WhatsApp bot for session creation and invites
- [ ] Transit/cycling travel profiles
- [ ] Session history and favorite venues
- [ ] Push notifications for partner arrival
- [ ] Shareable session summary (screenshot/link)

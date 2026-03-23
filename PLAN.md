# Meet Me Halfway — Project Plan

## v1 MVP Status

| Phase | Status | Tests |
|-------|--------|-------|
| P0 — Core Real-time Flow | Done | 89 |
| P1 — Destination Features | Done | 103 |
| P2 — Robustness | Done | 147 |

**Deployed:** [meet-me-halfway-4ae79.web.app](https://meet-me-halfway-4ae79.web.app)

## Remaining to Production

- [ ] Firebase RTDB security rules: deploy via `firebase deploy --only database`
- [ ] Error tracking (Sentry or similar) — client-side exception capture
- [ ] Rate limiting on client API calls (Mapbox Directions, Google Places)
- [ ] E2E tests with Playwright (create → join → stream → midpoint → navigate)
- [ ] Performance audit (Lighthouse PWA score, bundle size, FCP/LCP)
- [ ] Custom domain + SSL

## v2 Roadmap

- [ ] WhatsApp bot for session creation and invites
- [ ] Transit/cycling travel profiles
- [ ] Session history and favorite venues
- [ ] Push notifications for partner arrival
- [ ] Shareable session summary (screenshot/link)

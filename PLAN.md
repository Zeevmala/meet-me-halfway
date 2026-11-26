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
- [ ] Stored destination — built behind `VITE_STORED_DESTINATION`, rules
      live, `privacy.html` describes it conditionally. Next release: set it
      to `true` in the deploy job. Still to build: telling someone whose
      navigation app is heading for a different point than the one the
      session stored
- [ ] Custom domain + SSL

## v2 Roadmap

- [ ] Meeting point balanced by travel time (Mapbox Matrix, minimax) — built;
      the creator computes it and publishes it in `participants/0`. Next
      release: set `VITE_BALANCED_MEETING=true` in the deploy job, once this
      release's rules are live, and add the Matrix request and the published
      point to `privacy.html` in that commit. Tabs still on a bundle older
      than this release cannot read the point and will show the centroid
      until they reload — leave a full release between the two steps
- [ ] Rank venues by the same matrix (fairness of the trip to each venue,
      not straight-line distance from the meeting point)
- [ ] One destination for the whole session: the picked venue is per device
      today, so two people can navigate to different places. The same move
      fixes it — the creator's record carries the pick
- [ ] WhatsApp bot for session creation and invites
- [ ] Transit/cycling travel profiles
- [ ] Session history and favorite venues
- [ ] Push notifications for partner arrival
- [ ] Shareable session summary (screenshot/link)

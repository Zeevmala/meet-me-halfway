# Launch Checklist

## Pre-Launch

### Infrastructure
- [ ] Terraform applied to production GCP project
- [ ] Cloud SQL instance running with PostGIS extension enabled
- [ ] Cloud Run service deployed with min 2 instances
- [ ] Secret Manager populated: DATABASE_URL, WHATSAPP_TOKEN, GOOGLE_PLACES_KEY, FIREBASE_CREDENTIALS_JSON
- [ ] Firebase RTDB security rules deployed (`infra/database.rules.json`)
- [ ] Firebase Hosting configured with `apps/web/dist`
- [ ] Custom domain DNS pointing to Cloud Run / Firebase Hosting
- [ ] SSL certificates provisioned and active

### Database
- [ ] Alembic migrations run against production (`alembic upgrade head`)
- [ ] PostGIS extension verified (`SELECT PostGIS_Version()`)
- [ ] Connection pool size tuned for Cloud Run concurrency

### API
- [ ] CORS_ORIGINS set to production domain (not `*`)
- [ ] SESSION_LINK_SECRET set (non-empty, random 32+ chars)
- [ ] Rate limiter verified (60 req/60s per IP)
- [ ] `/health` and `/api/v1/health` returning ok
- [ ] WhatsApp webhook verification handshake successful
- [ ] WHATSAPP_APP_SECRET set for HMAC signature verification

### Clients
- [ ] PWA build passes (`npm run build`)
- [ ] PWA deployed to Firebase Hosting
- [ ] Mapbox token scoped to production domain
- [ ] Firebase API key restricted to production domain
- [ ] Service worker caching verified
- [ ] Mobile app EAS build created for Android + iOS
- [ ] Deep links tested: `meetmehalfway://s/{id}` and `https://meetmehalfway.app?session={id}`

### Testing
- [ ] All backend tests pass (target: 89+ tests)
- [ ] Load test passes: `/midpoint` p95 < 800ms, `/sessions` p95 < 200ms
- [ ] PWA typecheck clean (`tsc --noEmit`)
- [ ] RTL layout verified in Hebrew and Arabic
- [ ] i18n strings complete for en, he, ar

### Security
- [ ] Pydantic validation on all inputs (lat/lng bounds, max_participants 2-5)
- [ ] UUID validation middleware active
- [ ] HMAC webhook signature verification enabled
- [ ] No secrets in client bundles (check VITE_* vars)
- [ ] CORS restricted to production origins

---

## Launch Day

### Deployment Order
1. Apply Terraform infrastructure changes
2. Run Alembic migrations
3. Deploy API to Cloud Run
4. Deploy PWA to Firebase Hosting
5. Verify `/api/v1/health` returns `{"status": "ok", "db": "connected", "firebase": "ready"}`
6. Send test WhatsApp message to webhook
7. Create test session end-to-end

### Rollback Plan
- Cloud Run: revert to previous revision via `gcloud run services update-traffic`
- Database: `alembic downgrade -1` (test downgrade path before launch)
- PWA: redeploy previous Firebase Hosting version

---

## Post-Launch Monitoring

### Metrics to Watch (First 24h)
- Cloud Run request latency (p50, p95, p99)
- Cloud Run error rate (5xx responses)
- Cloud SQL connection count and CPU utilization
- Firebase RTDB concurrent connections
- Google Places API quota usage
- Session creation rate
- Midpoint computation latency

### Alerts to Configure
- Cloud Run 5xx rate > 1% over 5 minutes
- Cloud SQL CPU > 80% for 10 minutes
- Cloud Run latency p95 > 2s
- Places API quota > 80%

### Logs
- Structured JSON logs via structlog → Cloud Logging
- Key fields: `request_id`, `session_id`, `status_code`, `duration_ms`
- Filter: `severity >= WARNING` for error monitoring

### Weekly Review
- Session volume trends
- Most popular meeting areas (centroid clusters)
- Places API cache hit rate
- Session completion rate vs expiry rate

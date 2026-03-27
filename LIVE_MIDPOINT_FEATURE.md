# Feature: Live Location Midpoint with Navigation

## Objective

Extend the Meet Me Halfway project to support **real-time live location sharing** between 2 participants, with automatic geodesic midpoint calculation and turn-by-turn navigation routes from each participant to the midpoint. This mirrors WhatsApp's "Share live location" UX but adds midpoint computation + dual routing.

## Architecture

```
┌─────────────┐                              ┌─────────────┐
│ Participant A│──► watchPosition ──► Firebase RTDB ◄── watchPosition ◄──│ Participant B│
└──────┬───────┘         sessions/{id}/a          sessions/{id}/b       └──────┬───────┘
       │                        │                        │                      │
       │                ┌───────▼────────┐               │                      │
       │                │  Client-side   │               │                      │
       │                │  recalculate() │               │                      │
       │                │  • geodesic midpoint           │                      │
       │                │  • fitBounds (A, B, mid)       │                      │
       │                │  • debounced route fetch       │                      │
       │                └───────┬────────┘               │                      │
       │                        │                        │                      │
       │              ┌─────────▼──────────┐             │                      │
       │              │ Mapbox Directions   │             │                      │
       │              │ A→mid  &  B→mid     │             │                      │
       │              └─────────┬──────────┘             │                      │
       │                        │                        │                      │
       │              ┌─────────▼──────────┐             │                      │
       │              │ Mapbox GL JS map   │             │                      │
       │              │ • 2 participant markers           │                      │
       │              │ • 1 midpoint marker │             │                      │
       │              │ • 2 route polylines │             │                      │
       │              │ • Waze/GMaps links  │             │                      │
       │              └────────────────────┘             │                      │
       └─────────────────────── PWA ────────────────────────────────────────────┘
```

## Session Flow

1. **User A** opens the app → creates session (6-char alphanumeric code, e.g. `KX9R4M`) → URL updates to `?session=KX9R4M`
2. **User A** shares the link via WhatsApp (deep link button: `https://wa.me/?text=...`)
3. **User B** taps the link → app detects `?session=` param → auto-joins as participant B
4. Both grant browser geolocation → `navigator.geolocation.watchPosition` streams location to Firebase RTDB
5. On each location update from either participant:
   - Compute spherical geodesic midpoint (see math below)
   - Update midpoint marker on map
   - Fit map bounds to show all 3 points
   - Debounced (3s): fetch Mapbox Directions for `A→midpoint` and `B→midpoint`
6. Render dual route polylines with distance/duration stats
7. Deep link buttons: navigate to midpoint via Waze or Google Maps

## Implementation Tasks

### 1. Firebase RTDB Setup

Add Firebase Realtime Database to the project if not already present.

**Data model:**
```json
{
  "sessions": {
    "KX9R4M": {
      "a": { "lat": 32.0853, "lng": 34.7818, "accuracy": 12, "ts": 1710500000000 },
      "b": { "lat": 31.7683, "lng": 35.2137, "accuracy": 8, "ts": 1710500001000 },
      "created": 1710499000000
    }
  }
}
```

**Firebase dependencies (CDN compat for existing project):**
```html
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js"></script>
```

Or if the project uses npm:
```bash
npm install firebase
```

**RTDB security rules (starter — tighten later):**
```json
{
  "rules": {
    "sessions": {
      "$sessionId": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

### 2. Session Management Module

Create a module/component for session lifecycle:

```typescript
// session.ts
function generateSessionId(): string {
  // 6-char, no ambiguous chars (0/O, 1/I/L excluded)
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getSessionFromURL(): string | null {
  return new URLSearchParams(window.location.search).get('session');
}

function updateURL(sessionId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('session', sessionId);
  history.replaceState(null, '', url.toString());
}

function getShareURL(sessionId: string): string {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('session', sessionId);
  return url.toString();
}

function shareViaWhatsApp(sessionId: string): void {
  const url = getShareURL(sessionId);
  const text = encodeURIComponent(`Let's meet halfway! Join my session: ${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}
```

**Role assignment logic:**
- If URL has `?session=X` on page load → join as **B**
- If user clicks "Create session" → generate ID, become **A**
- Each participant writes ONLY to their own path: `sessions/{id}/{role}`

### 3. Real-Time Geolocation Module

```typescript
// geolocation.ts
const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000,
};

function startWatching(
  onUpdate: (loc: { lat: number; lng: number; accuracy: number; ts: number }) => void,
  onError: (err: GeolocationPositionError) => void
): number {
  return navigator.geolocation.watchPosition(
    (pos) => {
      onUpdate({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now(),
      });
    },
    onError,
    GEO_OPTIONS
  );
}
```

- Push each update to Firebase: `db.ref(\`sessions/${sessionId}/${role}\`).set(loc)`
- Listen for partner updates: `db.ref(\`sessions/${sessionId}/${partnerRole}\`).on('value', ...)`
- On `beforeunload`: clear watch + remove own location from RTDB

### 4. Geodesic Midpoint Calculation

Use spherical midpoint — sufficient for typical meetup distances (<200km, error <1m vs ellipsoidal):

```typescript
// geo-math.ts
function geodesicMidpoint(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): { lat: number; lng: number } {
  const toRad = (d: number) => d * Math.PI / 180;
  const toDeg = (r: number) => r * 180 / Math.PI;

  const φ1 = toRad(lat1), λ1 = toRad(lng1);
  const φ2 = toRad(lat2), λ2 = toRad(lng2);
  const Δλ = λ2 - λ1;

  const Bx = Math.cos(φ2) * Math.cos(Δλ);
  const By = Math.cos(φ2) * Math.sin(Δλ);

  const φm = Math.atan2(
    Math.sin(φ1) + Math.sin(φ2),
    Math.sqrt((Math.cos(φ1) + Bx) ** 2 + By ** 2)
  );
  const λm = λ1 + Math.atan2(By, Math.cos(φ1) + Bx);

  return { lat: toDeg(φm), lng: toDeg(λm) };
}

function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

### 5. Mapbox Directions Integration

```typescript
// directions.ts
async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  profile: 'driving' | 'walking' | 'cycling' = 'driving'
): Promise<{ geometry: GeoJSON.LineString; duration: number; distance: number } | null> {
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/` +
    `${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!data.routes?.length) return null;
  const route = data.routes[0];
  return {
    geometry: route.geometry,
    duration: route.duration,   // seconds
    distance: route.distance,   // meters
  };
}
```

**Debounce route fetching** at 3 seconds — `watchPosition` fires frequently, don't spam the Directions API on every tick.

### 6. Map Rendering (Mapbox GL JS)

The map must show:
- **Participant A marker** (green `#00d4aa`, pulsing dot)
- **Participant B marker** (blue `#6c8cff`, pulsing dot)
- **Midpoint marker** (pink `#ff6b9d`, larger, with emoji or icon)
- **Route A→midpoint** (green polyline, 4px, 0.8 opacity)
- **Route B→midpoint** (blue polyline, 4px, 0.8 opacity)

Use `mapbox://styles/mapbox/dark-v11` basemap.

Pre-add GeoJSON sources and line layers on map load, then update source data on each recalculation:

```javascript
map.getSource('route-a').setData(routeGeoJSON);
```

After each recalculation, `fitBounds` to include all three points with `padding: 80`.

### 7. Navigation Deep Links

Once midpoint is calculated, provide one-tap navigation:

```typescript
function getNavLinks(mid: { lat: number; lng: number }) {
  return {
    waze: `https://waze.com/ul?ll=${mid.lat},${mid.lng}&navigate=yes`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${mid.lat},${mid.lng}`,
  };
}
```

### 8. UI States

The bottom panel has two states:

**State 1: Waiting for partner** (only participant A present)
- Show session code
- "Share via WhatsApp" button (green, #25d366)
- "Copy link" button

**State 2: Both connected** (midpoint calculated)
- Midpoint coordinates display
- Total distance between participants
- Route A stats: distance + duration
- Route B stats: distance + duration
- Waze + Google Maps navigation buttons

Top bar shows:
- Session code badge with live indicator dot
- Two status pills: "You" (with green/blue dot) + "Partner" (gray when offline, colored when online)

### 9. Cleanup & Edge Cases

- **`beforeunload`**: `clearWatch()` + remove own location from RTDB
- **Session TTL**: Add `created` timestamp to session. Optionally add a Firebase Cloud Function or client-side check to ignore sessions older than 24h.
- **Stale partner data**: If partner's `ts` is >60s old, show "Partner location stale" warning.
- **Geolocation denied**: Show clear error message with instructions to enable location services.
- **Single participant**: Don't attempt midpoint/route calculation until both locations are present.
- **Firebase disconnect**: Use `.info/connected` to detect offline state and show UI indicator.

### 10. Design Tokens

```css
:root {
  --bg: #0a0a0f;
  --surface: #13131a;
  --surface-2: #1c1c28;
  --border: #2a2a3a;
  --text: #e8e8f0;
  --text-muted: #8888a0;
  --accent: #00d4aa;
  --participant-a: #00d4aa;
  --participant-b: #6c8cff;
  --midpoint: #ff6b9d;
  --font: 'DM Sans', system-ui, sans-serif;
  --mono: 'DM Mono', monospace;
}
```

Use `backdrop-filter: blur(20px)` on all overlay cards for glass-morphism effect over the map.

## File Structure Guidance

Integrate into the existing project structure. If the project uses React + component architecture, create:

```
src/
  features/
    live-midpoint/
      LiveMidpointPage.tsx    # Main page component
      useGeolocation.ts       # watchPosition hook
      useSession.ts           # Firebase session hook
      useMidpoint.ts          # Computation + route fetching
      geo-math.ts             # geodesicMidpoint, haversine
      directions.ts           # Mapbox Directions wrapper
      components/
        SessionBadge.tsx
        StatusPills.tsx
        WaitingCard.tsx
        MidpointCard.tsx
        MapView.tsx           # Mapbox GL JS container
```

If the project is simpler (single-page / vanilla JS), integrate into the existing structure — don't force a rewrite. The reference implementation is available as a single-file HTML at the root of this project.

## Config Required

The following credentials are needed (store in `.env`, never commit):

```env
VITE_MAPBOX_TOKEN=pk.xxx
VITE_FIREBASE_API_KEY=xxx
VITE_FIREBASE_AUTH_DOMAIN=xxx.firebaseapp.com
VITE_FIREBASE_DATABASE_URL=https://xxx-default-rtdb.firebaseio.com
VITE_FIREBASE_PROJECT_ID=xxx
```

## Constraints

- **Do NOT use Leaflet for this feature** — Mapbox GL JS is required for Directions API integration and vector tile performance.
- **Spherical midpoint is intentional** — do not import geographiclib or turf for the midpoint. At meetup distances the error vs ellipsoidal is <1m.
- **Debounce route API calls** — minimum 3s between Directions API requests.
- **No server-side component** — everything runs client-side + Firebase RTDB.
- **Mobile-first** — this will primarily be used on phones opened from WhatsApp links. Touch targets ≥44px, full viewport map, bottom sheet UI pattern.
- **beforeunload cleanup is mandatory** — remove participant data from RTDB on tab close.

## Acceptance Criteria

1. User A can create a session and share via WhatsApp link
2. User B can join by tapping the shared link
3. Both participants see each other's live location on the map in real-time
4. Geodesic midpoint appears when both locations are available
5. Driving routes from each participant to midpoint render as colored polylines
6. Route distance + ETA shown for both participants
7. One-tap navigation to midpoint via Waze or Google Maps
8. Stale/offline partner detection (>60s without update)
9. Clean session teardown on page unload
10. Works on mobile Chrome + Safari (primary WhatsApp browsers)

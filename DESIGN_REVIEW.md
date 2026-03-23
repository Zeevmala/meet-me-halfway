# Frontend Design Review

Audit of UI/UX quality across color consistency, typography, accessibility, responsive layout, and interaction patterns.

## What's Good

- **CSS variable system** — 15 theme tokens in `:root`, consistent usage across all components
- **RTL support** — CSS logical properties (`inset-inline-start/end`, `margin-inline-start`) throughout; Hebrew and Arabic layouts verified correct
- **Touch targets** — All interactive elements meet 44px minimum (buttons, venue items, profile toggles)
- **Loading states** — Venue list shimmer skeleton, "Connecting..." text, waiting card shimmer animation
- **Error states** — Dedicated full-screen error with icon, title, message, and retry button; GPS denied/unavailable/timeout each have specific copy
- **Dark theme** — Glass-morphism cards with backdrop-blur, dark-v11 Mapbox basemap, consistent dark surface colors
- **Typography hierarchy** — Clear scale: 18px titles, 14px body, 13px subtitles, 12px meta, 11px labels
- **Micro-interactions** — Button press scale(0.97), marker pulse rings, card slide-up animation, dot blink
- **i18n complete** — 45+ keys in en/he/ar, all UI strings translated
- **Marker differentiation** — Green (you), blue (partner), pink (midpoint), gray (venue), green (selected venue) with distinct sizes and glows
- **Stale partner UX** — Dimmed grayscale marker + warning banner with hint sublabel
- **Navigation deep links** — Waze and Google Maps one-tap links point to selected venue or midpoint

## What Was Fixed (This Commit)

| Issue | Fix |
|-------|-----|
| No `:focus-visible` on buttons, toggles, venue items | Added `outline: 2px solid var(--live-blue)` with 2px offset |
| Badge/pills overlap lang switcher at 320px | Media query `(max-width: 360px)` shrinks badge, stops before switcher |
| Offline banner color `#ffb300` hardcoded | `--live-amber` CSS variable |
| Venue rating color `#ffb800` hardcoded | `--live-gold` CSS variable |
| Venue marker color `#888` hardcoded | `--live-gray` CSS variable |
| Gray pill dot `#555` hardcoded | `--live-gray` CSS variable |

## What Needs Work

| Priority | Issue | Effort | Notes |
|----------|-------|--------|-------|
| P2 | No loading state for initial map render | M | Add skeleton/shimmer while Mapbox GL JS loads (~1-2s on slow connections) |
| P2 | Badge still overlaps lang switcher at desktop when both pills show "Partner" text | S | Lang switcher overlays badge at z-index 15 vs 10 — consider integrating switcher into badge |
| P2 | No focus indicators on Mapbox GL zoom/compass controls | S | Mapbox controls are outside our CSS scope — would need `.mapboxgl-ctrl button:focus-visible` |
| P3 | Bottom sheet not draggable | L | Cards are fixed-position, not gesture-aware. Would need a gesture library (react-spring, framer-motion) |
| P3 | Accuracy circles may clutter at low zoom | S | Hide below zoom level 12 |
| P3 | Map markers may overlap at certain zoom levels | M | Implement Mapbox symbol-sort-key or marker clustering |
| P3 | Venue marker labels use `left: 50%` not logical property | S | Change to `inset-inline-start: 50%` for RTL |
| P3 | No empty state illustration | S | "No venues found" could have a simple SVG illustration |
| P3 | LanguageSwitcher uses Tailwind classes (not CSS variables) | S | Inconsistent with rest of UI which uses custom CSS. Low priority — works correctly |

**Effort key:** S = small (< 1h), M = medium (1-4h), L = large (4h+)

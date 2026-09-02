# Architecture

**Meet Me Halfway** is a zero-backend PWA. Every participant's browser runs the
same pipeline: read locations, compute a midpoint, find venues near it, and
route everyone to the meeting point. There is no server to coordinate them.

This document describes how that pipeline is structured and why.

---

## The two layers

```
apps/web/src/core/dag/            framework- and domain-agnostic execution core
apps/web/src/features/live-midpoint/graph/    this app's graph, built on it
```

`core/dag` knows nothing about maps, participants or React. It provides a
`Result` type, a transport error taxonomy, a circuit breaker, and one resource
combinator. `features/live-midpoint/graph` declares the actual nodes, their
edges, and the policies that govern them.

---

## Sources and nodes

The distinction that shapes everything else: **event streams are inputs to the
graph, not nodes in it.**

```
SOURCES (hooks — push into the runtime)     NODES (pure or policy-governed)

  useAuth ─────── uid ──┐
  useLiveSession ───────┼──►  slots  ──┬──►  midpoint  ──┬──►  venues  ──┐
  useLiveGeolocation ───┘   (SoA,      │                 │              │
                             stable    │                 └──►  destination
  ui.selectedVenueId ──────► slots)    │                          │
  ui.travelProfile ────────────────────┤                          │
                                       └──────────┬───────────────┘
                                                  ▼
                                               routes  ──►  frame
```

`useLiveGeolocation`, `useLiveSession`, `useAuth` and `useNetworkStatus` are
unchanged adapters. They own subscriptions and lifecycles; the graph derives
from what they emit and never writes back.

Edges are declared in `graph/edges.ts` and executed in topological order by
`graph/runtime.ts`. The declaration is load-bearing, not documentation: the
runtime walks `TOPO_ORDER`, and `assertAcyclic` runs at module load.

### Why the cycle check earns its place

There is no cycle today. There is one waiting. Re-centring venue search on the
selected venue, or deriving a time-balanced midpoint from route durations —
both natural next features — close `midpoint → venues → destination →
midpoint`. Either would ship as a hang discovered on somebody's phone. With
the edges declared, it is a failing test that names both nodes.

---

## Node contracts

| Node | Kind | Input | Output | On failure |
|---|---|---|---|---|
| `slots` | pure | sources | `SlotVector` | — |
| `midpoint` | pure | `slots` | `LatLng \| null` | — |
| `venues` | effectful | `midpoint` | raw `PlaceResult[]` | degrade to empty |
| `destination` | pure | `midpoint`, `venues`, selection | `LatLng \| null` | — |
| `routes` | effectful | `slots`, `destination`, profile | slot-keyed `RouteInfo[]` | degrade to last-good |
| `frame` | pure | all of the above | `GraphSnapshot` | — |

`slots` is a **structure of arrays** indexed by `ParticipantIndex`, length
`MAX_PARTICIPANTS`, with `null` for a vacant slot. Routes, accuracy circles,
marker colours and Mapbox layer ids all key off the same `i`. They previously
did not, which is covered under *Slot identity* below.

---

## Resilience

Every effectful node is one `createResource` instance. The policy record
(`graph/policies.ts`) is the whole configuration surface:

| | debounce | maxWait | admit | timeout | retry | breaker | TTL | degrade |
|---|---|---|---|---|---|---|---|---|
| `venues` | 5 s | 15 s | 100 m | 8 s | 2 | 4 fails / 30 s | 5 min | empty |
| `routes` | 3 s | 9 s | 200 m | 10 s | 2 | 5 fails / 60 s | 60 s | last-good |

### Two predicates, deliberately separate

- **`admits`** is metric and stateful. It compares the new input against the
  last input *actually dispatched*, so its baseline advances with every
  accepted call.
- **`identity`** is pure and depends only on the current input. It exists
  solely to collapse concurrent duplicate requests.

Quantising coordinates into grid cells is fine for `identity` — a collision
merely skips a duplicate. It must never gate admission. A stationary user
whose GPS noise straddles a cell boundary would flip cells at roughly 1 Hz and
pay for one API call per second, indefinitely. A displacement predicate
structurally cannot do that.

### The breaker holds no timer

`core/dag/breaker.ts` compares `openedAt + cooldown` against an injected
clock. Transitions are `closed → open → halfOpen → closed`, with the cooldown
doubling on each failed probe up to a ceiling.

Two reasons it is lazy rather than scheduled. A timer-driven probe reproduces
the exact bug it replaces — the old code doubled a backoff on HTTP 429 but the
movement guard returned before the timer was re-armed, so a stationary user
never recovered. And backgrounded mobile browsers throttle `setTimeout` to
minutes and freeze it entirely under bfcache, silently turning a 60-second
window into an indefinite one. A timestamp comparison is immune to both.

Admission is breaker-aware, so an elapsed cooldown is itself a reason to
dispatch; one backstop wake covers the case where inputs stop arriving.

### Degradation, not rollback

Nothing on the derived layer is compensable — it is all reads and pure
compute. So there is no rollback matrix, only a degradation policy per node.
The one genuinely compensable write path, the RTDB participant entry, already
has `onDisconnect` plus explicit `cleanup` in `useLiveSession`.

A degraded node keeps serving its last good value **only while younger than
its TTL**. Past that the value is dropped rather than served. A stale route is
a confident lie; falling back to nothing lets `MidpointCard` show an honest
straight-line distance instead.

---

## Atomic state

`graph/runtime.ts` exposes one frozen `GraphSnapshot`, consumed through
`useSyncExternalStore`. That contract requires `getSnapshot` to return a
referentially identical value when nothing changed, so:

- The snapshot is computed on **write**, never on read.
- `SlotVector` is compared element-wise, because RTDB hands over a fresh
  participants array on every heartbeat. Without that, each heartbeat would
  allocate a new vector and invalidate the whole graph.
- `setSources` takes a **patch object** rather than per-key setters, so a
  handler changing two sources produces one tick and one render.

The runtime is created **per mount**. A module singleton would survive
StrictMode's unmount/remount and hand the second mount the first's epoch
counters, breaker state and in-flight aborts; under Vitest it would bleed
state across files. `useGraphRuntime` detects the simulated teardown and
stands up a replacement, so `npm run dev` behaves like production.

`selectedVenueId` and `travelProfile` live in the runtime, not React state.
Mirroring them would create two sources of truth and the venue list would
highlight a venue the graph had already stopped routing to.

---

## Defects this structure fixed

All were verified in the code before being fixed, and all have regression
tests.

| Defect | Where it lived |
|---|---|
| **Slot identity.** Indices were a dense rank over a mutating set, recomputed per snapshot. A departure renumbered everyone after the leaver; own index was ranked over `participantUids` while others were ranked over `participants`, so two participants could share a slot; and a clamp aliased surplus uids onto the last slot. | `useLiveSession.assignIndex` |
| **Route/colour misalignment.** `LiveMap` resolved accuracy circles by participant index but routes by array position, while painting both into slot `i`'s colour. For *any* joiner the two disagreed, so every route rendered under the wrong participant. `MidpointCard` consumed the same array correctly-by-position, so neither could be fixed alone. | `LiveMap` + `useDirections` |
| **Sticky rate limit.** A 429 doubled the debounce delay, but the movement guard returned before the timer was re-armed. With nobody moving, the failure was permanent. | `useDirections` |
| **Partial-failure wipeout.** `Promise.all` meant one participant's 429 discarded every route, and the state was never updated — leaving stale routes on screen with no indication. | `useDirections` |
| **Debounce starvation.** Both fetch hooks reset their timer on every dependency change, and dependencies changed at GPS rate. While a user walked, the first fetch could be starved indefinitely. | both hooks |
| **Loading flicker.** The success path checked the signal captured for that call, but `catch`/`finally` read whichever controller was current, so an abandoned request cleared `loading` under its replacement. | `useVenueSearch` |
| **Pinned stale selection.** Reconciliation only ran when the venue list was non-empty, so a search returning nothing left a deleted venue pinned as the destination. | `LiveMidpointPage` |
| **Unreachable 429.** `searchNearbyVenues` threw `RATE_LIMITED` and caught it in its own catch block two lines later, returning `[]`. Callers could not tell a rate limit from "no venues here". | `places-api` |
| **Three failure conventions.** Throw, return-empty, and set-a-state-code, in one codebase — plus two magic error strings no consumer read. | throughout |

---

## Performance

`N` = participants (≤ 5), `V` = venues (≤ 20), `C` = coordinates per route.

| Unit | Time | Space |
|---|---|---|
| graph compile (once) | O(K + E) | O(K + E) |
| scheduler per tick | O(K + E) → constant at K=6, E=11 | O(K) |
| `slots` | O(N) | O(N) |
| `midpoint` | O(N) | O(1) |
| `venues` rank | O(V log V) | O(V) |
| `destination` | O(V) | O(1) |
| `routes` | O(N) requests | **O(N·C)** |
| `frame` | O(N + V) | O(N + V) |

**The binding constraint is route geometry, not compute.** The entire
per-tick arithmetic budget is roughly one `atan2` per participant. Meanwhile
`overview=full` returns complete geometry — commonly 1,500–4,000 coordinate
pairs for a long urban route, so ~150–400 KB per route as parsed GeoJSON, and
the last-good buffer that buys degradation doubles it.

This is why "vectorized execution" here means a structure-of-arrays fold and
not typed arrays or SIMD: at N ≤ 5 a `Float64Array` costs more in allocation
than the arithmetic it saves. The measurable win is in what the graph *avoids
fetching*, not in how it multiplies.

**Known follow-up:** `overview=simplified` would cut roughly 90% of that
memory with no visible difference at the zoom `fitBounds` produces. Not done
here because it changes rendered output and deserves its own review.

**Scale limits.** `MAX_PARTICIPANTS = 5` is enforced client-side only — RTDB
rules have no `numChildren()`. Mapbox at 5 participants × 1 request / 3 s is
~100 req/min against a 300/min free tier.

---

## Testing

`core/dag` and `graph` take their I/O through injected ports (`graph/ports.ts`),
including `now`, `schedule` and `cancel`. Tests drive a virtual clock and pass
fake fetchers — no fake timers, no global mocks, no module mocking. The page
test supplies a fake `Ports` and so exercises the real derivation rather than
a stub.

```bash
cd apps/web
npm test                              # 344 tests
npx eslint src/ --max-warnings=0      # exhaustive-deps and the RTL rule are CI-fatal
npm run tsc
```

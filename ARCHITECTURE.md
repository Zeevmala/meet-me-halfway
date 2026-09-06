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
SOURCES (adapters — push into the runtime)   NODES (pure or policy-governed)

  useAuth ───────── uid ─┐
  useLiveSession ────────┼──► liveness ──► slots ──┬──► midpoint ──┬──► venues ─┐
  useLiveGeolocation ────┤   (clock)      (SoA,    │               │            │
  ui.selectedVenueId ────┤                 stable) │               └──► destination
  ui.travelProfile ──────┤                         │                        │
  ui.ownName ────────────┴──► presence             └──► phase               │
                             (RTDB write)                                   ▼
                                                              routes ──► frame
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
| `liveness` | pure | participants, clock | `stale[]` + `nextFlipAtMs` | — |
| `slots` | pure | sources, `liveness` | `SlotVector` | — |
| `presence` | effectful | session + own position | RTDB write | report failed |
| `midpoint` | pure | `slots` | `LatLng \| null` | — |
| `phase` | pure | status, `slots`, `liveness` | `SessionPhase` | — |
| `venues` | effectful | `midpoint` | raw `PlaceResult[]` | degrade to empty |
| `destination` | pure | `midpoint`, `venues`, selection | `LatLng \| null` | — |
| `routes` | effectful | `slots`, `destination`, profile | slot-keyed `RouteInfo[]` | degrade to last-good |
| `frame` | pure | all of the above | `GraphSnapshot` | — |

### Liveness holds one timer, not an interval

Staleness is `now - lastSeen >= 30s` — a predicate over a clock, exactly like
the breaker's cooldown. `liveness` returns the earliest instant at which some
participant's staleness flips, and the runtime arms a single wake for it.

This replaces a 10s `setInterval` that ran for the life of the session. The
argument is the one made for the breaker below and applies verbatim: mobile
browsers throttle `setInterval` to minutes and freeze it under bfcache, so a
tab resumed after ten minutes reported staleness from before it was
backgrounded. Recomputing from the clock has no such window.

The boundary is inclusive (`>=`) deliberately. With a strict `>`, a
participant was still fresh at the instant the wake fired, the node re-derived
the same target, and the wake re-armed at zero delay — the same livelock the
breaker had at its half-open boundary.

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
| `presence` | 3 s | 3 s | 10 m | 10 s | 3 | 5 fails / 60 s | — | report failed |

`presence` is a **write**, and still one `createResource`: everything the
combinator provides is what the hand-rolled throttle in `useLiveSession` was
approximating. Its TTL is 0 because a write has no value to serve — there is
nothing to degrade *to*, so a failure is reported and the UI can say so.

A `Retry-After` on a 429 now floors the retry delay, and one too long to sleep
through inside a dispatch (> `retryBaseMs × 8`) becomes the breaker's cooldown
instead: the retry loop owns seconds, the breaker owns the long tail. The
header was previously parsed into the error and read by nobody.

Every attempt runs under its own `AbortController`, chained to the dispatch
signal, so a deadline cancels the request rather than merely stopping waiting
for it. It did not, and the retry went out alongside the request it replaced.

### One bulkhead across all nodes

`core/dag/semaphore.ts` caps total in-flight I/O at 4, applied at the
composition root rather than inside a policy. A breaker is reactive — it only
closes the tap after failures are paid for — and nothing bounded simultaneity:
a route dispatch fans out per occupied slot, against a six-per-host HTTP/1.1
cap the RTDB socket and map tiles also draw on.

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
| **Half-open livelock.** `retryAtMs()` returned `openedAt + openMs` whenever the breaker was not closed — while half-open, an instant already in the past. Admission read it as "cooldown over", `allow()` refused the call, and the backstop wake re-armed at `max(0, past − now)` = 0: an unbounded `setTimeout(…, 0)` chain for the whole life of the probe, on exactly the degraded network that opened the breaker. | `core/dag/breaker` |
| **Discarded `Retry-After`.** Parsed into `RATE_LIMITED` and read by nobody, so a 429 saying 30 s was retried at 1 s and 2 s and counted twice against the breaker — the same class as the magic strings above. | `core/dag/errors` |
| **Uncancelled timeout.** The per-attempt deadline resolved `TIMEOUT` without aborting, so the retry went out beside the request it replaced: up to `retryAttempts × slots` sockets against a six-per-host cap. | `core/dag/resource` |
| **Stability discarded at the render boundary.** The graph returned stable `slots` and `routes`; the page rebuilt four projections with `.map()` in the render body and `LiveMap` was not memoised, so every GPS fix re-ran `setData` on five route sources — thousands of coordinate pairs per second for geometry that had not changed. | `LiveMidpointPage` + `LiveMap` |
| **Positional fit guard.** `fitBounds` jitter suppression compared a vector mixing participants, midpoint and venue by array index, so a joiner arriving as a venue was deselected made it measure a participant against a venue. Same aliasing class as slot identity. | `LiveMap` |
| **Unhandled join rejection.** `createSession`/`joinSession` threw into an effect with no `.catch()`; every failure raised an unhandled rejection on top of the Sentry event already recorded, and an unmount mid-join left a retry loop running against a dead component. | `useLiveSession` + page |
| **`setPhase` inside a `setParticipants` updater.** React requires updaters to be pure and StrictMode double-invokes them. `phase` was `useState` written from six sites despite being a total function of status, roster and liveness. | `useLiveSession` |
| **Polled staleness.** A 10 s `setInterval` drove a clock predicate, so a backgrounded tab reported staleness from before it was suspended — the failure mode the breaker is explicitly designed against, reproduced one module over. | `useLiveSession` |
| **Config read in eight places.** `ports.ts` claimed to have ended this; the Places key was still read in three modules, so the flag rendering the venue list and the client calling the API were separate reads that could disagree. `validateEnv` checked five of six required variables, omitting the one whose absence silently disables App Check. | throughout |

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
per-tick arithmetic budget is roughly one `atan2` per participant. Route
geometry is four orders of magnitude larger, and it is uploaded to the Mapbox
worker, not just held.

Two changes act on that, and they compound. Directions now request
`overview=simplified` rather than `full`, cutting roughly 90% of the
1,500–4,000 coordinate pairs a long urban route returns — the difference is not
visible at the zoom `fitBounds` settles on (`maxZoom: 16`, 350 px of bottom
padding) for a 4 px line. And the page's projections are memoised on the
graph's stable arrays, so `setData` fires when geometry changes rather than on
every GPS fix.

This is why "vectorized execution" here means a structure-of-arrays fold and
not typed arrays or SIMD: at N ≤ 5 a `Float64Array` costs more in allocation
than the arithmetic it saves. The measurable win is in what the graph *avoids
fetching*, not in how it multiplies.

**Scale limits.** `MAX_PARTICIPANTS = 5` is enforced client-side only — RTDB
rules have no `numChildren()`. Mapbox at 5 participants × 1 request / 3 s is
~100 req/min against a 300/min free tier; the semaphore caps simultaneity at 4,
which is the browser's per-host budget rather than the API's.

**Known limitation.** `presence` is driven by geolocation, so a device whose
`watchPosition` goes quiet stops publishing and peers eventually show it as
stale. This is unchanged from the hook it replaces. Making the heartbeat
self-sustaining is a behaviour change, not a refactor, and belongs in its own.

---

## Testing

`core/dag` and `graph` take their I/O through injected ports (`graph/ports.ts`),
including `now`, `schedule` and `cancel`. Tests drive a virtual clock and pass
fake fetchers — no fake timers, no global mocks, no module mocking.

Since the composition root landed, that extends to the React tree:
`LiveMidpointPage.test.tsx` passes ports through `ServicesProvider` instead of
`vi.mock`-ing `graph/ports`, and `firebase-factory.test.ts` carries the
persistence-chain and App Check coverage without resetting the module registry
between cases — which the previous suite needed, because construction happened
in module state on first import.

```bash
cd apps/web
npm test                              # 410 tests
npx eslint src/ --max-warnings=0      # exhaustive-deps and the RTL rule are CI-fatal
npm run tsc
```

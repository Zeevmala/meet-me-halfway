# Review checklist (meet-me-halfway)

Drawn from this repo's CLAUDE.md. A violation of any item is a blocking finding.

- Schema and rules ship together. A change to what the client writes or reads under `/sessions` changes `infra/database.rules.json` in the same PR, with a test in `apps/web/rules/` proving the allowed and the denied case. A breaking change is split expand/contract.
- Invariants that a rule can express are enforced by the rule, not only by a client check.
- `import.meta.env.VITE_*` is read only in `lib/config.ts`. Nothing below the composition root constructs a Firebase handle or reads a credential.
- Fallible operations return `Result<T, E>`; nothing throws, returns an empty value or writes a state code instead.
- Derived values are graph nodes, not `useState` driven by an interval. New effectful work is a `ResourcePolicy`; I/O goes through `graph/ports.ts`.
- Coordinates are GeoJSON `[lng, lat]` at boundaries and `{ lat, lng }` internally. Slot indexes are the one `ParticipantIndex` space everywhere.
- Anything drawn over the map lives in `.live-topbar` or `.live-sheet`. No style on the element handed to `mapboxgl.Marker`.
- Inline styles use logical properties; new UI text exists in `en.json` and `he.json`; distances inside text are wrapped in `<bdi>`.
- A change to what leaves the device, who can read it or how long it is kept updates `public/privacy.html` in the same PR, with a test where the policy makes a promise.
- No `.skip`, `.only`, `@ts-ignore`, `eslint-disable` or `as any` added, no test file deleted, no assertion loosened.
- No token, key or Firebase config value in source or tests.

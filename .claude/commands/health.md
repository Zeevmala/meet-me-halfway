---
description: Check that this checkout can build, test and run — toolchain, dependencies, env, and optionally the RTDB emulator
allowed-tools: Bash, Read
---

# Dev environment health check

The app is a static client (`apps/web/`): no backend, no Docker, no database
server. Run each check in order and report a checklist. A failed check does not
stop the ones after it unless it says so.

## 1. Toolchain
`node -v` (CI uses the version in `.github/workflows/web.yml`) and `npm -v`.

## 2. Dependencies
`apps/web/node_modules` exists and `npm ls --depth=0` in `apps/web` exits 0.
If not: `npm ci` in `apps/web`, and stop here if that fails.

## 3. Environment
Never print values. Report only which names are missing.
- `apps/web/.env.e2e` exists (committed; fake keys — the e2e build needs it).
- For `npm run dev` or a production build: the six required `VITE_*` names
  from `.env.example`. Missing is fine in a cloud session — unit tests,
  typecheck and the e2e build need none of them. Say so instead of failing.

## 4. Typecheck and one test
`npm run tsc`, then `npx vitest run src/features/live-midpoint/lib/geo-math.test.ts`.

## 5. Emulator (only with the `rules` argument)
`java -version`. If $ARGUMENTS contains `rules`, from the repo root:
`npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:rules"`.
A download refused by the network policy is an environment limit, not a
failure of the repo: report it as "blocked", with the host.

## Output
```
Health
======
Node / npm:      OK (v22.x / 10.x)
Dependencies:    OK / installed / FAIL
Env (.env.e2e):  OK / missing
Env (app keys):  OK / missing: VITE_… (not needed for tests)
Typecheck:       OK / FAIL
Unit test:       OK / FAIL
Emulator:        OK / blocked (host) / skipped
```

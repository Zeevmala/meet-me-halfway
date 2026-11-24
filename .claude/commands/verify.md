---
description: Run everything CI runs, in CI's order, and report each job as passed, failed or blocked
allowed-tools: Bash, Read, Grep
---

# Full local gate

The Stop hook already runs the fast half (two `tsc` projects, eslint, prettier,
vitest) on every turn. This is the slow half as well: what `web.yml` runs
before a deploy. Use it before opening a pull request, and after any change to
`infra/database.rules.json`, `firebase.json`, `e2e/` or the service worker.

Run from the repo root, in this order. Keep going after a failure — the report
is more useful whole — but never mark a job passed that did not run.

1. **lint** — the `lint` job's own steps, read from `.github/workflows/web.yml`
   and run in `apps/web` exactly as written there (audit, eslint with its
   `--ext` list and `--max-warnings=0`, prettier with its glob). Do not
   substitute `prettier --check .`: CI's glob is narrower, and the wider one
   reports files CI never checks.
2. **typecheck** — `npm run tsc`
3. **test** — `npm test`
4. **hook tests** — `node --test .claude/hooks/verify-on-stop.test.mjs`
5. **rules** — needs Java:
   `npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:rules"`
6. **build** — `npm run build` needs the real `VITE_*` keys. Without them run
   `npm run build:e2e` and report `build` as "e2e bundle only".
7. **e2e** — `npm run build:e2e`, then
   `npx -y firebase-tools@15.29.0 emulators:exec --only database --project demo-meet-me-halfway "npm --prefix apps/web run test:e2e -- --trace off"`

A job that cannot start because the network policy refuses a download (the
emulator jar, a browser) is **blocked**, with the host named — not failed, and
not passed. CI is still the gate for it; say so.

If $ARGUMENTS names jobs (`rules e2e`), run only those.

## Report

```
lint        passed | failed | blocked
typecheck   …
test        … (N tests)
hook tests  …
rules       …
build       …
e2e         …
```

Then, for each failure, the first failing assertion or error with its
`file:line`, and nothing else. Do not fix anything unless asked.

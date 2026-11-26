# Store beta: one client, a destination that holds, an Android shell

Status: **draft, not approved.** 2026-11-26. Approving it means moving it to `docs/designs/` and adding a row to `SITEMAP.md`.

## The answer

The app is already launched: it is a URL, and a joiner needs no install. A store listing is a second door into the same client, not a second client. Three things have to be true before that door is worth opening, and only the last is about the store.

1. **The destination has to hold once people set off.** Today it disappears. This is the launch blocker.
2. **The screen has to stay on while sharing.** A locked phone stops reporting.
3. **The store app is a shell onto the hosted origin.** Android: a Trusted Web Activity. iOS: stay on the web for this beta.

## Decisions

| # | Decision | Outcome |
| --- | --- | --- |
| D1 | Which store first | **Decided 2026-11-26: Google Play, internal track.** iOS stays web for this beta; a separate design covers TestFlight |
| D2 | How much of the Cartowolf adoption lands before store screenshots | **Decided 2026-11-26: ticket 1 and the `--live-gray` contrast fix.** Palette swap and Mapbox Standard after the beta |
| D3 | Order of work | **Decided 2026-11-26: the stored destination first,** then the wake lock, then the shell |
| D4 | Firebase plan | Open. Recommended: stay on Spark for a closed beta; Blaze, with a budget alert, before any open test |
| D5 | Slot 0 keeps a fixed colour when the palette changes | Open. Blocks adoption ticket 2 only |

## What was measured

On `main` at `64f731d`.

- **The destination disappears two minutes after the other person leaves the page.** A probe over the pure nodes (`deriveLiveness` → `buildSlotVector` → `deriveMidpoint`), two people 20 km apart, the peer's last write at t=0:

  ```
  t=10s  {"counted":[0,1],"midpoint":{"lat":32.0800,"lng":34.8850}}
  t=60s  {"counted":[0,1],"midpoint":{"lat":32.0800,"lng":34.8850}}
  t=121s {"counted":[0],"midpoint":null}
  ```

  Navigate opens Waze or Google Maps (`MidpointCard.tsx:185`, `:195`) with the coordinate of that instant. The page goes to the background and stops writing. `DEPARTED_THRESHOLD_MS` is 120 s (`graph/nodes.ts:31`), and `deriveMidpoint` returns `null` under two counted points (`nodes.ts:198`). That a backgrounded mobile page stops reporting is taken from `nodes.ts`'s own comment and from browser behaviour; it was not measured on a device here.
- **No destination is stored anywhere.** The rules declare `created`, `creatorUid`, `slots`, `participants` under a session and nothing else. A picked venue is a local source (`deriveDestination`, `nodes.ts:213`). Two people who tap Navigate a minute apart are sent to two coordinates.
- **No wake lock.** `grep -rn wakeLock apps/web/src` prints nothing.
- **Hosting cannot serve `/.well-known/`.** `firebase.json` ignores `**/.*`, so the directory is never uploaded, and the `**` rewrite answers the path with `index.html` and status 200. Asset-link verification would fail without an error anywhere.
- **Invite links take their origin from the page**: `` `${window.location.origin}?code=${code}` `` (`useShareLink.ts:33`).
- **60 hand-written colours**: `node design/scripts/check-colors.mjs apps/web/src` from the factory at `f9682fc` reports 54 in `live-midpoint.css`, 5 in `participant-config.ts`, 1 in `LiveMap.tsx`. Unchanged from the adoption note.
- **Manifest** has name, icons (192, 512, 512 maskable) and `display: standalone`. It has no `id` and no `screenshots`.

From the vendors' own pages, read 2026-11-26:

- Realtime Database on Spark allows 100 simultaneous connections and the limit cannot be raised. One tab is one connection. The 101st is refused.
- A personal Play account created after 2023-11-13 needs a closed test with 12 testers opted in for 14 consecutive days before it may apply for production. The internal track has no such wait.
- TestFlight: up to 100 internal testers with no review; external testers need Beta App Review on the first build of a version.
- App Store guideline 4.2 rejects apps that are a website in a web view. Developers report rejections after adding push, location and share.
- A Trusted Web Activity can delegate geolocation to Android's own permission dialog (Bubblewrap `locationDelegation`). If asset links fail to verify, the app opens with browser UI.

## Architecture

### One client

The store app loads `https://<origin>/` and holds no copy of the bundle. Three reasons, each from this repository.

- **Rules and client are one contract** (`CLAUDE.md`, "Rules and client deploy together"). A hosting deploy reaches open tabs on their next visibility change. A bundle inside a store binary stays in the field for weeks, so every schema change would have to keep its old shape alive for weeks.
- **Configuration is bound to the origin**: the reCAPTCHA Enterprise key, the Mapbox token's URL restriction, Firebase Auth's authorised domains and the CSP. A bundled web view runs at a local origin where none of them hold.
- **Invite links are built from `window.location.origin`.** In a bundled web view that is the shell's origin, and every invite would point at nothing.

### A destination that holds (slice 1)

The centroid is right while people are deciding and wrong once they are driving. The session needs one stored destination that outlives its writer.

- **Schema.** `sessions/{code}/destination: { lat, lng, ts, by }`. `ts` equals the server's `now`; `by` is the writer's slot key, a string, so the rule can look the holder up without matching keys. Writable by any slot holder of a fresh session, readable by slot holders only, numbers range-checked, no other fields. Write-once until cleared; any holder may clear it.
- **Behaviour.** The first Navigate tap writes the destination shown on that device, then opens the navigation app. From then on every device shows and routes to the stored point. A participant who goes silent while a destination is set is shown as on the way, not dropped. Clearing it returns the session to the live centroid.
- **Why session level and not the creator's record.** The meeting-point branch (`claude/nifty-mayer-iv17gy`) publishes `mlat`/`mlng` inside `participants/0`, which is deleted when the creator disconnects. The creator tapping Navigate is exactly that disconnect. The two fit together: the balanced point decides *where*, this field records *that it was agreed*.
- **Rollout.** Expand/contract. The session node has `$other: false`, so the rules that accept `destination` deploy one release before any client writes it. The client ships behind a flag in the first release.
- **Privacy.** A stored destination is a location derived from positions. `public/privacy.html` changes in the same pull request, with a rules test for "readable only by people who joined".

### Screen stays on (slice 2)

Request a Screen Wake Lock while own location is being published. Release it when the page is hidden, request it again when it returns. A refusal (battery saver, unsupported browser) is silent. No schema, no dependency.

This does not make sharing survive a switch to another app. Slice 1 is what makes that survivable.

### Android shell (slices 3 and 4)

- **Slice 3, hosting.** Serve `/.well-known/assetlinks.json` as JSON. Keep the `**/.*` ignore; add a rewrite from the well-known path to a file under `public/`. A test reads `firebase.json` and fails if the path falls through to `index.html`; the live suite fetches the URL and checks the content type.
- **Slice 4, shell.** Bubblewrap project under `android/` (`twa-manifest.json` committed, generated project not). A CI job builds a signed App Bundle from a keystore held in repository secrets and uploads it as an artifact. `locationDelegation` on. Manifest gains `id` and `screenshots`.
- **Not possible in a TWA:** background location. That needs a foreground service, which means native code. Out of scope here.

### iOS

Three options.

| Option | Cost | Risk |
| --- | --- | --- |
| Web only: Safari, Add to Home Screen | none; works today | no store presence |
| Capacitor shell loading the hosted origin, TestFlight internal | Apple Developer Program, a macOS CI runner, signing | guideline 4.2 at external beta and at App Store review |
| Native app | a second client | breaks "one client" |

Recommended: web only for this beta. The 4.2 test is "does it run in a browser", and this app does by design. Decide after the Android beta whether background location justifies native work; that would also answer 4.2.

### Cartowolf adoption

The adoption note (`design/adoption/meet-me-halfway.md` in the factory) lists four tickets. Store screenshots freeze the look, so whatever lands must land before slice 5.

- **Before the beta:** ticket 1 (load tokens and fonts, alias `--live-*`), and `--live-gray`, which is 2.65:1 on the background.
- **After the beta:** ticket 2 (palette; needs D4), ticket 3 (Mapbox Standard; changes the CSP and the e2e stylesheet assertion), ticket 4 (remaining literals, then `check-colors` in the gate).

## Slices, in order

| # | Slice | Done when | Built by |
| --- | --- | --- | --- |
| 1a | Rules accept `destination` | rules tests cover holder write, non-holder denial, range, extra field; deployed. **Deployed 2026-11-26 (#119)** | session (schema is ask-first) |
| 1b | Client writes and reads it, behind a flag | unit tests on the node and the runtime at `DEPARTED_THRESHOLD_MS`; e2e: A taps Navigate and leaves, B still has the destination. **Built 2026-11-26** behind `VITE_STORED_DESTINATION` | session |
| 1c | Flag on | `VITE_STORED_DESTINATION=true` in the deploy job. The policy already describes it, conditionally | session (touches `.github/`) |
| 2 | Wake lock | test with a fake `navigator.wakeLock`: requested on publish, released on hide, re-requested on show | factory ticket |
| 3 | Hosting serves asset links | `firebase.json` test; live fetch returns JSON | session (touches `firebase.json`) |
| 4 | Android shell and CI build | signed `.aab` artifact from CI; installs; opens full screen; `/?code=` link opens the app | session (touches `.github/`) |
| A1 | Cartowolf ticket 1 and `--live-gray` | `check-colors` count falls; contrast test passes | factory ticket |
| 5 | Listing material | screenshots en and he, feature graphic, descriptions, Data safety answers drawn from `privacy.html`, under `store/` | session |
| 6 | A production failure is readable | Sentry `release` is the commit; source maps are uploaded before the deploy job strips them; the `main` build fails on an empty DSN; a test ties the DSN's host to `connect-src` | session (touches `.github/`) |
| 7a | The map is off the path to the first text | `LiveMap` is lazy; the first text needs no Mapbox chunk | factory ticket |
| 7b | CI gates the phone, not the desktop | `lighthouserc.cjs` on the mobile preset; LCP 2.5 s, TBT 200 ms, CLS 0.1 at `error`; `categories:pwa` removed | factory ticket, after 7a |

Slices 2 and A1 are small and checkable by the gate. They are the right first live runs for the factory once #115 merges.

## First app-health audit, 2026-11-26

Run by the `app-health` agent (`.claude/agents/app-health.md`) on `f866818`, in a 4-core container on Node 22, with the e2e build. That build has fake keys, so no map paints and the numbers cover the shell only. Slices 6, 7a and 7b come from it.

- **First load, Lighthouse mobile, 3 runs:** LCP 5.6 s, TBT 475 ms, CLS 0.000, performance 0.68. Desktop, which is what CI runs: LCP 1.08 s, performance 0.98. Every performance assertion in `lighthouserc.cjs` is `warn`.
- **Bytes:** 236 kB gzip to "Loading…", 804 kB gzip to the first real text. `LiveMidpointPage.tsx:28` imports the map statically, so the 549 kB Mapbox chunk loads before sign-in or the location prompt.
- **Error reports:** `Sentry.init` sets no `release`. Source maps are built in CI and deleted at `web.yml:249` without being uploaded, so production stack traces are minified. `VITE_SENTRY_DSN` is not in `validateAppConfig`; an empty secret builds green with reporting off.
- **No report at all for:** a full session, a missing or expired session, a failed anonymous sign-in, a refused presence write, and Directions or Places answering 401, 403 or 429.
- **e2e:** the two-device spec runs on Chromium with a desktop user agent at a phone-sized viewport. No WebKit and no Android device descriptor.
- **Safety net:** `npm run test:coverage` exits 1 (`@vitest/coverage-v8` is not a dependency). Measured with the provider loaded from outside the repo: 93.0% statements.

Before an open test, not before the beta:

- Route requests are N² per session: every client fetches a route for every occupied slot (`policies.ts:278`).
- e2e on WebKit and an Android descriptor; an axe pass on the loaded session in both languages.
- The silent failures above report.
- `privacy.html` and `terms.html` exist in Hebrew.
- The CSP drops `apis.google.com`, `www.recaptcha.net` and the Mapbox `style-src`, none of which the bundle uses.

## Only the owner can do

- Create the Play Console account and pass identity verification.
- Create the upload keystore and add it to repository secrets. Never commit it.
- Enrol 12 testers. The 14-day clock starts when the twelfth opts in.
- Confirm in the Firebase console whether App Check is enforced for Realtime Database.
- Restrict the Mapbox token to the hosting origin.
- Blaze before an open test. This needs a Cloud Billing account, which the factory's 2026-11-16 "No GCP" decision rules out for new services. Staying on Firebase past 100 connections reverses that for this project and belongs in `docs/brain/DECISIONS.md`.

## Not in this design

Background location, push notifications, a custom domain, an iOS binary, the balanced meeting point itself.

A custom domain does not block the beta: `web.app` can serve asset links. Moving origin later costs the stored anonymous identity and every link already shared, so decide it before an open test.

## Risks

- **Play target API level.** New apps must target a recent Android API. Check Bubblewrap's default against Play's current requirement when slice 4 is built.
- **Asset-link fingerprint.** It is the Play app-signing key's, not the upload key's, and exists only after the first upload. Slice 3 ships the route; the fingerprint follows in a one-line change.
- **Two writers of `destination`.** Decided 2026-11-26: write-once until cleared, enforced by the rules; the refused writer re-reads and treats a stored destination as done. Left open: the refused device's navigation app already has its own coordinate, and the card does not yet say that the session agreed on another.

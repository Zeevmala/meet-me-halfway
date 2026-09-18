import { test, expect } from "@playwright/test";
import {
  BEER_SHEVA,
  CODE,
  EILAT,
  ERROR_TITLE,
  HAIFA,
  JERUSALEM,
  MIDPOINT,
  NAZARETH,
  PILLS,
  TEL_AVIV,
  WAITING,
  createSession,
  participant,
  uid,
} from "./helpers/session";

/**
 * The core flow, against the real Realtime Database emulator running
 * `infra/database.rules.json` unmodified.
 *
 * The suite this replaced asserted only that `.live-page` was visible — a class
 * the app also renders on the error boundary, the connecting state, the session
 * error panel and all three geolocation failure screens. It therefore passed
 * green throughout the 2026-09-11 outage, when every slot claim in production
 * was being denied. Nothing here can pass unless a session is really created,
 * a slot is really claimed and a midpoint is really derived.
 */

test("creator mints a code and waits alone", async ({ browser }) => {
  const a = await participant(browser, uid("creator"), TEL_AVIV);
  const code = await createSession(a);

  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await expect(a.page.locator(PILLS)).toHaveCount(1, { timeout: 20_000 });
  await expect(a.page.locator(WAITING)).toBeVisible();
  // Alone is not a midpoint: it needs two occupied slots.
  await expect(a.page.locator(MIDPOINT)).toHaveCount(0);

  await a.ctx.close();
});

test("a joiner reaches the midpoint, and leaving snaps it back", async ({
  browser,
}) => {
  const a = await participant(browser, uid("alice"), TEL_AVIV);
  const code = await createSession(a);

  const b = await participant(browser, uid("bob"), HAIFA);
  await b.page.goto(`/?code=${code}`);
  await expect(b.page.locator(CODE)).toHaveText(code, { timeout: 30_000 });

  // Both sides converge: two pills each, waiting replaced by the midpoint.
  await expect(a.page.locator(PILLS)).toHaveCount(2, { timeout: 30_000 });
  await expect(b.page.locator(PILLS)).toHaveCount(2, { timeout: 30_000 });
  await expect(a.page.locator(WAITING)).toHaveCount(0, { timeout: 20_000 });
  await expect(a.page.locator(MIDPOINT)).toBeVisible({ timeout: 20_000 });
  await expect(b.page.locator(MIDPOINT)).toBeVisible({ timeout: 20_000 });

  // Closing the context drops the RTDB socket; the server-side onDisconnect
  // clears participants/{slot}, so the departed peer stops dragging the midpoint.
  await b.ctx.close();
  await expect(a.page.locator(PILLS)).toHaveCount(1, { timeout: 30_000 });
  await expect(a.page.locator(WAITING)).toBeVisible({ timeout: 20_000 });

  await a.ctx.close();
});

test("a rejoining participant returns to the same slot and colour", async ({
  browser,
}) => {
  const a = await participant(browser, uid("alice"), TEL_AVIV);
  const code = await createSession(a);

  const bobUid = uid("bob");
  const b1 = await participant(browser, bobUid, HAIFA);
  await b1.page.goto(`/?code=${code}`);
  await expect(b1.page.locator(PILLS)).toHaveCount(2, { timeout: 30_000 });
  const firstDot = await b1.page
    .locator(`${PILLS} .live-pill-dot`)
    .first()
    .getAttribute("class");
  await b1.ctx.close();

  // Same uid returns: claimSlot scans for an existing holder rather than
  // consuming a fresh index, so slots never renumber on churn.
  const b2 = await participant(browser, bobUid, HAIFA);
  await b2.page.goto(`/?code=${code}`);
  await expect(b2.page.locator(PILLS)).toHaveCount(2, { timeout: 30_000 });
  const secondDot = await b2.page
    .locator(`${PILLS} .live-pill-dot`)
    .first()
    .getAttribute("class");
  expect(secondDot).toBe(firstDot);

  await b2.ctx.close();
  await a.ctx.close();
});

test("an unparseable ?code= starts a new session rather than failing", async ({
  browser,
}) => {
  const a = await participant(browser, uid("stray"), TEL_AVIV);
  await a.page.goto("/?code=!!invalid");

  // getCodeFromURL rejects it before joining, so the app falls through to
  // create. Asserted deliberately: it is the current contract, not an accident.
  const codeEl = a.page.locator(CODE);
  await expect(codeEl).toBeVisible({ timeout: 30_000 });
  expect((await codeEl.textContent())?.trim()).toMatch(/^[A-Z0-9]{6}$/);
  await expect(a.page.locator(WAITING)).toBeVisible();
  await expect(a.page.locator(ERROR_TITLE)).toHaveCount(0);

  await a.ctx.close();
});

test("a code for a session that was never created is not found", async ({
  browser,
}) => {
  const a = await participant(browser, uid("lost"), TEL_AVIV);
  // Well-formed (passes isValidCode) but absent from the database.
  await a.page.goto("/?code=ZZZZZZ");

  await expect(a.page.locator(ERROR_TITLE)).toBeVisible({ timeout: 30_000 });
  await expect(a.page.locator(ERROR_TITLE)).toContainText(/not found/i);

  await a.ctx.close();
});

test("the sixth participant is refused, and the five before it are not", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const spots = [TEL_AVIV, HAIFA, JERUSALEM, BEER_SHEVA, EILAT];
  const a = await participant(browser, uid("p0"), spots[0]);
  const code = await createSession(a);
  const joined = [a];

  // Slots 1..4 — each must succeed. A false SESSION_FULL here is the
  // 2026-09-11 failure mode: a structural denial reported as capacity.
  for (let i = 1; i < spots.length; i++) {
    const p = await participant(browser, uid(`p${i}`), spots[i]);
    await p.page.goto(`/?code=${code}`);
    await expect(p.page.locator(CODE)).toHaveText(code, { timeout: 30_000 });
    await expect(p.page.locator(ERROR_TITLE)).toHaveCount(0);
    joined.push(p);
  }

  await expect(a.page.locator(PILLS)).toHaveCount(5, { timeout: 40_000 });

  // Sixth: genuinely full, because all five write-once slots are held.
  const sixth = await participant(browser, uid("p5"), NAZARETH);
  await sixth.page.goto(`/?code=${code}`);
  await expect(sixth.page.locator(ERROR_TITLE)).toBeVisible({
    timeout: 30_000,
  });
  await expect(sixth.page.locator(ERROR_TITLE)).toContainText(/full/i);

  await sixth.ctx.close();
  for (const p of joined) await p.ctx.close();
});

import { test, expect, type Browser } from "@playwright/test";

/**
 * Two-device live smoke test for the ghost-participant / midpoint fix.
 *
 * Exercises the real flow against the deployed RTDB: creator + joiner in
 * separate browser contexts (distinct geolocations), then closes the
 * joiner's context to drop its WebSocket. The server-side
 * `onDisconnect().remove()` armed on the joiner's first write must delete
 * `participants/{uid}`, so the creator's participant pill drops and the
 * midpoint "snaps back" — the acceptance test that a departed peer no
 * longer drags the computed midpoint.
 */

const TEL_AVIV = { latitude: 32.0853, longitude: 34.7818 };
const HAIFA = { latitude: 32.794, longitude: 34.9896 };

const CODE = ".live-badge-code";
const PILLS = ".live-badge-pills .live-pill";
const WAITING = ".live-waiting-title";

async function geoContext(
  browser: Browser,
  geolocation: { latitude: number; longitude: number },
) {
  return browser.newContext({
    geolocation,
    permissions: ["geolocation"],
    locale: "en-US",
  });
}

test("creator sees a joiner appear, then snap back when the joiner leaves", async ({
  browser,
  baseURL,
}) => {
  const ctxA = await geoContext(browser, TEL_AVIV);
  const pageA = await ctxA.newPage();
  await pageA.goto(baseURL!);

  // Creator boots: anonymous auth → session created → 6-char code shown.
  const codeEl = pageA.locator(CODE);
  await expect(codeEl).toBeVisible({ timeout: 45_000 });
  const code = (await codeEl.textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z0-9]{6}$/);

  // Alone: exactly one pill (self), still in the waiting state.
  await expect(pageA.locator(PILLS)).toHaveCount(1, { timeout: 20_000 });
  await expect(pageA.locator(WAITING)).toBeVisible();

  // Joiner opens the share link from a different location.
  const ctxB = await geoContext(browser, HAIFA);
  const pageB = await ctxB.newPage();
  await pageB.goto(`${baseURL}/?code=${code}`);
  await expect(pageB.locator(CODE)).toHaveText(code, { timeout: 45_000 });

  // Creator now sees two pills and the midpoint replaces the waiting card.
  await expect(pageA.locator(PILLS)).toHaveCount(2, { timeout: 45_000 });
  await expect(pageA.locator(WAITING)).toHaveCount(0, { timeout: 20_000 });

  // Joiner leaves — closing the context drops its RTDB socket, which fires
  // the server-side onDisconnect removal.
  await ctxB.close();

  // Snap-back: creator drops to one pill and the waiting card returns,
  // within seconds (onDisconnect removal, not the 30s stale timeout).
  await expect(pageA.locator(PILLS)).toHaveCount(1, { timeout: 25_000 });
  await expect(pageA.locator(WAITING)).toBeVisible({ timeout: 10_000 });

  await ctxA.close();
});

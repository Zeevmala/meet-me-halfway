import { test, expect } from "@playwright/test";
import { setupFirebaseMocks } from "./helpers/mock-firebase";
import { setupMapboxMocks } from "./helpers/mock-mapbox";
import { start, START_BUTTON } from "./helpers/start";

/**
 * What a visit does before anyone has agreed to anything, and after.
 *
 * These four used to assert that `.live-page` rendered, which the error
 * boundary's fallback satisfies too. The page also used to sign in, ask for
 * location and create or join a session as it loaded, so there was nothing
 * between "opened" and "sharing" to assert on.
 */

/** Requests that only a session makes: the sign-in, and the database. */
function sessionRequests(page: import("@playwright/test").Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("identitytoolkit.googleapis.com")) seen.push(url);
  });
  page.on("websocket", (socket) => seen.push(socket.url()));
  return seen;
}

test.beforeEach(async ({ page }) => {
  await setupFirebaseMocks(page);
  await setupMapboxMocks(page);
});

// Every visit used to write a session record that is never deleted — one
// that refused location, and a crawler's, included.
test("opens on the start screen: no sign-in, no database, no session", async ({
  page,
}) => {
  const requests = sessionRequests(page);

  await page.goto("/");

  await expect(page.locator(START_BUTTON)).toHaveText("Start a session", {
    timeout: 10_000,
  });
  await expect(page.locator(".live-start")).toContainText(
    "Your live location is shared with everyone who joins",
  );
  await expect(page.getByRole("link", { name: "Privacy" })).toBeVisible();
  // Long enough for a handshake that was going to start to have started.
  await page.waitForTimeout(2_000);
  expect(requests).toEqual([]);
  await expect(page.locator(".live-badge-code")).toHaveCount(0);
});

test("starting a session reaches the map, with a code to share", async ({
  page,
}) => {
  await page.goto("/");
  await start(page);

  await expect(page.locator(".live-badge-code")).toHaveText(
    /^([2-9A-HJKMNP-Z]{6}|[2-9A-HJKMNP-Z]{10})$/,
    { timeout: 30_000 },
  );
  await expect(page.locator(".live-waiting-title")).toBeVisible();
});

// Opening the link was the join: a link scanner took one of four slots
// that are never released.
test("a session link opens on an invitation, and joins nothing by itself", async ({
  page,
}) => {
  const requests = sessionRequests(page);

  await page.goto("/?code=MCK234");

  await expect(page.locator(START_BUTTON)).toHaveText(
    "Join and share my location",
    { timeout: 10_000 },
  );
  await page.waitForTimeout(2_000);
  expect(requests).toEqual([]);
});

test("a mangled link says it is not valid, without a start screen", async ({
  page,
}) => {
  await page.goto("/?code=!!invalid");

  await expect(page.locator(".live-error-title")).toHaveText(
    /^This link isn't valid/,
    { timeout: 10_000 },
  );
  await expect(page.locator(START_BUTTON)).toHaveCount(0);
});

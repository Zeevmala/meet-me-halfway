import type { Page } from "@playwright/test";

/**
 * The way Mapbox would answer `from` to `to`, made up from the request: a
 * straight line, a third longer than the crow flies, at 50 km/h by car or
 * 5 km/h on foot. Answered from the coordinates asked for, so a device that
 * routes again from somewhere else gets a different answer — which is how a
 * spec can tell it did.
 */
function routeFor(url: string) {
  const match =
    /directions\/v5\/mapbox\/(driving|walking)\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)/.exec(
      url,
    );
  if (match === null) return null;
  const [, profile, fromLng, fromLat, toLng, toLat] = match;
  const from = [Number(fromLng), Number(fromLat)];
  const to = [Number(toLng), Number(toLat)];
  const rad = Math.PI / 180;
  const dLat = (to[1] - from[1]) * rad;
  const dLng = (to[0] - from[0]) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from[1] * rad) * Math.cos(to[1] * rad) * Math.sin(dLng / 2) ** 2;
  const crowFliesM = 2 * 6_371_000 * Math.asin(Math.sqrt(a));
  const distance = Math.round(crowFliesM * 1.3);
  const metresPerSecond = profile === "walking" ? 5 / 3.6 : 50 / 3.6;
  return {
    geometry: { type: "LineString", coordinates: [from, to] },
    distance,
    duration: Math.round(distance / metresPerSecond),
  };
}

/** Intercept the Mapbox Directions API, answering from the request itself. */
export async function setupMapboxMocks(page: Page) {
  await page.route("**/api.mapbox.com/directions/**", (route) => {
    const answer = routeFor(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        answer === null
          ? { routes: [], code: "NoRoute" }
          : { routes: [answer], code: "Ok" },
      ),
    });
  });

  // Mock Mapbox GL tile/style requests to prevent errors
  await page.route("**/api.mapbox.com/styles/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 8,
        name: "mock",
        sources: {},
        layers: [],
      }),
    }),
  );

  await page.route("**/api.mapbox.com/v4/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );

  await page.route("**/tiles.mapbox.com/**", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );

  await page.route("**/events.mapbox.com/**", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
}

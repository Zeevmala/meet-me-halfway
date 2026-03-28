import type { Page } from "@playwright/test";

/** Intercept Mapbox Directions API with a canned route response */
export async function setupMapboxMocks(page: Page) {
  await page.route("**/api.mapbox.com/directions/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        routes: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [34.78, 32.08],
                [34.9, 32.0],
                [34.995, 31.925],
              ],
            },
            distance: 50000,
            duration: 3600,
          },
        ],
        waypoints: [
          { location: [34.78, 32.08] },
          { location: [34.995, 31.925] },
        ],
      }),
    }),
  );

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

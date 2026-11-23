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

  // The Matrix API, answered as if every trip to every candidate took the
  // same twenty minutes and every candidate were already on a road. All
  // equal, the fairest candidate is the first one — the group's centroid — so
  // the session publishes a fair point exactly where the geographic midpoint
  // is, and the spec can still measure the marker against the participants.
  await page.route("**/api.mapbox.com/directions-matrix/**", (route) => {
    const url = new URL(route.request().url());
    const coordinates = (url.pathname.split("/").pop() ?? "")
      .split(";")
      .map((pair) => pair.split(",").map(Number));
    const sources = (url.searchParams.get("sources") ?? "").split(";");
    const destinations = (url.searchParams.get("destinations") ?? "")
      .split(";")
      .map(Number);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: "Ok",
        durations: sources.map(() => destinations.map(() => 1200)),
        destinations: destinations.map((index) => ({
          location: coordinates[index],
          distance: 0,
        })),
      }),
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

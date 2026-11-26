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

  // The Matrix API, answered by straight-line distance: every candidate
  // meeting point is echoed back unsnapped, and a trip takes as long as it is
  // far. The fairest candidate for two people is then the geographic midpoint,
  // which is where `live-session.spec.ts` expects the marker — reached through
  // the real matrix client, selection and graph node rather than around them.
  await page.route("**/api.mapbox.com/directions-matrix/**", (route) => {
    const url = new URL(route.request().url());
    const points = (url.pathname.split("/").pop() ?? "")
      .split(";")
      .map((pair) => pair.split(",").map(Number) as [number, number]);
    const pick = (name: string) =>
      (url.searchParams.get(name) ?? "")
        .split(";")
        .map((i) => points[Number(i)] ?? ([0, 0] as [number, number]));
    const sources = pick("sources");
    const destinations = pick("destinations");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: "Ok",
        durations: sources.map(([lng, lat]) =>
          destinations.map(([dLng, dLat]) =>
            Math.round(Math.hypot(lng - dLng, lat - dLat) * 100_000),
          ),
        ),
        destinations: destinations.map((location) => ({ location })),
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

import { test, expect } from "@playwright/test";

import type { MidpointResponse, SessionResponse } from "../../packages/shared/types";

test.describe("PWA bootstrap", () => {
  test("map container renders", async ({ page }) => {
    await page.goto("/");
    // The map div is mounted by Map.tsx inside #root
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.locator(".mapboxgl-map")).toBeVisible({ timeout: 10_000 });
  });

  test("page title is set", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Meet Me Halfway/i);
  });

  test("header renders app title", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("venue list renders when session and midpoint are available", async ({ page }) => {
    const sessionMock: SessionResponse = {
      session_id: "test-123",
      status: "active",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
      participant_count: 2,
      max_participants: 5,
    };

    const midpointMock: MidpointResponse = {
      session_id: "test-123",
      centroid: { lat: 31.93, lng: 34.99 },
      search_radius_m: 1200,
      participant_count: 2,
      venues: [
        {
          place_id: "ChIJabc",
          name: "Café Midpoint",
          lat: 31.93,
          lng: 34.99,
          rating: 4.5,
          user_ratings_total: 100,
          open_now: true,
          distance_to_centroid_m: 200,
          score: 0.85,
          types: ["cafe"],
          vicinity: "1 Main St",
        },
      ],
    };

    await page.route("/api/v1/sessions/test-123", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sessionMock) })
    );
    await page.route("/api/v1/sessions/test-123/midpoint", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(midpointMock) })
    );

    await page.goto("/?session=test-123");

    // Trigger midpoint poll by waiting for the interval (5s) — or trigger directly
    await page.waitForTimeout(5500);

    await expect(page.locator('[data-testid="venue-list"]')).toBeVisible();
    await expect(page.getByText("Café Midpoint")).toBeVisible();
  });
});

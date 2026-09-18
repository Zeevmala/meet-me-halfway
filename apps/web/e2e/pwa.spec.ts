import { test, expect } from "@playwright/test";
import { setupEmulatorAuth } from "./helpers/fake-auth";
import { setupMapboxMocks } from "./helpers/mock-mapbox";
import { uid } from "./helpers/session";

test.beforeEach(async ({ page }) => {
  await setupEmulatorAuth(page, uid("pwa"));
  await setupMapboxMocks(page);
});

test("manifest link is present", async ({ page }) => {
  await page.goto("/");
  const manifest = page.locator('link[rel="manifest"]');
  await expect(manifest).toBeAttached({ timeout: 10_000 });
});

test("page has correct title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Meet Me Halfway/i, { timeout: 10_000 });
});

import { test, expect } from "@playwright/test";
import { setupFirebaseMocks } from "./helpers/mock-firebase";
import { setupMapboxMocks } from "./helpers/mock-mapbox";

test.beforeEach(async ({ page }) => {
  await setupFirebaseMocks(page);
  await setupMapboxMocks(page);
});

test("app loads and shows the live page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".live-page")).toBeVisible({ timeout: 10_000 });
});

test("app shows auth or session state after load", async ({ page }) => {
  await page.goto("/");
  // The app should show either the main page, a connecting state, or an auth error
  const livePage = page.locator(".live-page");
  await expect(livePage).toBeVisible({ timeout: 10_000 });

  // Verify the page contains meaningful content (not blank)
  const text = await livePage.textContent();
  expect(text?.length).toBeGreaterThan(0);
});

test("joiner can open a session link without crashing", async ({ page }) => {
  await page.goto("/?code=MOCK01");
  await expect(page.locator(".live-page")).toBeVisible({ timeout: 10_000 });
});

test("app does not crash with invalid session code", async ({ page }) => {
  await page.goto("/?code=!!invalid");
  await expect(page.locator(".live-page")).toBeVisible({ timeout: 10_000 });
});

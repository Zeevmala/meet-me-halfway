import { defineConfig, devices } from "@playwright/test";

/**
 * Live smoke-test config — drives the DEPLOYED site against the real
 * Firebase RTDB (no mocks, no local webServer). Kept separate from the
 * mocked CI suite (playwright.config.ts) so `npm test` / CI never hit
 * production. Run explicitly:
 *   npx playwright test --config playwright.live.config.ts
 */
export default defineConfig({
  testDir: "./e2e-live",
  timeout: 120_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL:
      process.env.LIVE_URL ?? "https://meet-me-halfway-4ae79.web.app",
    trace: "retain-on-failure",
    // Use an installed Chromium-branded browser (real GPU/WebGL) so
    // mapbox-gl initializes like a real device. The bundled Playwright
    // headless-shell lacks WebGL on Windows, which trips the app's
    // ErrorBoundary. Override with LIVE_CHANNEL=chrome if Edge is absent.
    channel: process.env.LIVE_CHANNEL ?? "msedge",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

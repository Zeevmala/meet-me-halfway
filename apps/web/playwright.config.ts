import { defineConfig, devices } from "@playwright/test";

/**
 * Escape hatch for environments whose installed Chromium build does not match
 * the one this @playwright/test version downloads (sandboxes, air-gapped CI).
 * Unset everywhere else, so the managed browser is still the default.
 */
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4173",
    geolocation: { latitude: 32.08, longitude: 34.78 },
    permissions: ["geolocation"],
    ...(executablePath === undefined
      ? {}
      : { launchOptions: { executablePath } }),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "npm run preview",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});

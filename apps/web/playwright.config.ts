import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e suite runs the `--mode e2e` build (`npm run build:e2e`) under the
 * headers firebase.json serves in production, against a Realtime Database
 * emulator loaded with the real rules. Run it under the emulator from the
 * repo root:
 *
 *   npx -y firebase-tools@15.29.0 emulators:exec --only database \
 *     --project demo-meet-me-halfway "npm --prefix apps/web run test:e2e"
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4173",
    geolocation: { latitude: 32.08, longitude: 34.78 },
    permissions: ["geolocation"],
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Mapbox GL needs WebGL, which headless Chromium on a GPU-less runner
        // only provides through SwiftShader, and Chromium no longer falls
        // back to it unasked. Without this the map fails to initialise and
        // the error boundary replaces the page.
        launchOptions: { args: ["--enable-unsafe-swiftshader"] },
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      // The two-device spec asserts on the rendered map, and WebGL in
      // headless Firefox on the CI runner is unverified. Chromium covers it;
      // the Firefox smoke specs still run.
      testIgnore: /live-session\.spec\.ts/,
    },
  ],
  webServer: {
    // `--mode e2e` so preview adds the emulator to connect-src (and nothing
    // else) on top of the production headers — see vite.config.ts.
    command: "npm run preview -- --mode e2e --strictPort",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});

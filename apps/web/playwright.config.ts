import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: "http://localhost:4173",
    geolocation: { latitude: 32.08, longitude: 34.78 },
    permissions: ["geolocation"],
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

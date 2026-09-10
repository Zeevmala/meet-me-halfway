/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

/**
 * Security-rules tests run against the Realtime Database emulator, so they
 * need a real Node environment and a running emulator — neither of which the
 * main jsdom suite should have to care about. `npm run test:rules` wraps this
 * in `firebase emulators:exec`.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["rules/**/*.test.ts"],
    // The emulator is a shared resource: parallel files would race on
    // clearDatabase() between each other's beforeEach.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});

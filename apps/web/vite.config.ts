/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { appCheckPairingError } from "./tooling/app-check-pairing";

/** Replace __BUILD_HASH__ in sw.js after build so the cache version auto-bumps. */
function swCacheBust() {
  return {
    name: "sw-cache-bust",
    closeBundle() {
      const swPath = resolve(__dirname, "dist/sw.js");
      try {
        const content = readFileSync(swPath, "utf-8");
        const hash = createHash("md5")
          .update(Date.now().toString())
          .digest("hex")
          .slice(0, 8);
        writeFileSync(swPath, content.replace("__BUILD_HASH__", hash));
      } catch {
        // sw.js not present (e.g. test runs) — skip
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Refuse to produce a bundle whose App Check is half-configured. Checked here
  // rather than in validateAppConfig because that runs in the browser, so the
  // same rule there would pass CI and then blank the page for every user.
  const pairingError = appCheckPairingError(loadEnv(mode, __dirname, "VITE_"));
  if (pairingError !== null) {
    throw new Error(`[app-check] ${pairingError}`);
  }

  return {
    plugins: [react(), tailwindcss(), swCacheBust()],
    server: {
      hmr: true,
    },
    optimizeDeps: {
      include: [
        "mapbox-gl",
        "firebase/app",
        "firebase/auth",
        "firebase/database",
      ],
    },
    build: {
      sourcemap: !!process.env.CI,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            firebase: ["firebase/app", "firebase/auth", "firebase/database"],
            mapbox: ["mapbox-gl"],
            i18n: ["i18next", "react-i18next"],
            sentry: ["@sentry/react"],
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      include: ["src/**/*.test.{ts,tsx}", "tooling/**/*.test.ts"],
    },
  };
});

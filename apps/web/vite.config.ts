/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

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

export default defineConfig({
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
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

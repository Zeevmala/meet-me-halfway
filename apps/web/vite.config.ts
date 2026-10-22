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
    // Phones only get geolocation in a secure context, so `npm run tunnel`
    // fronts this server with a Cloudflare quick tunnel on a random
    // *.trycloudflare.com host. Vite's DNS-rebinding guard rejects unknown
    // Host headers, the HMR socket's included. Cloudflare owns that zone's
    // DNS, so allowing it reopens no rebinding path.
    allowedHosts: [".trycloudflare.com"],
    // The tunnel dials this exact port. Exit if it is taken rather than drift
    // to 5174 and leave the tunnel serving whatever holds 5173.
    port: 5173,
    strictPort: true,
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

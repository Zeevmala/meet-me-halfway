/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve } from "path";
import { createHash } from "crypto";

/**
 * The built RTL text plugin. Its package's `exports` map only admits
 * `src/index.js`, but Mapbox `import()`s a standalone file, so the alias below
 * reaches past it — located through the package's own entry rather than a
 * hard-coded node_modules path, so hoisting cannot move it out from under us.
 */
const RTL_TEXT_PLUGIN =
  /^@mapbox\/mapbox-gl-rtl-text\/dist\/mapbox-gl-rtl-text\.js(?=\?|$)/;
const rtlTextPluginFile = resolve(
  dirname(createRequire(import.meta.url).resolve("@mapbox/mapbox-gl-rtl-text")),
  "../dist/mapbox-gl-rtl-text.js",
);

interface FirebaseHostingConfig {
  hosting: {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
}

/**
 * The headers Firebase Hosting sends on every response, for `vite preview`.
 *
 * Read from firebase.json rather than copied, so the e2e suite runs under the
 * policy production actually serves. It did not before: preview sent no CSP,
 * so the production CSP blocking Mapbox's stylesheet — which pushed every map
 * marker below the canvas — was invisible to every test.
 *
 * Only the `**` rule applies; the per-glob cache rules have nothing to say
 * about what a test can observe. The e2e build's RTDB emulator is the one
 * addition: it is a loopback origin production never talks to, so it joins
 * `connect-src` in that mode alone and the rest of the policy stays verbatim.
 */
function productionHeaders(rtdbEmulatorHost: string | undefined) {
  const firebase = JSON.parse(
    readFileSync(resolve(__dirname, "../../firebase.json"), "utf-8"),
  ) as FirebaseHostingConfig;
  const global = firebase.hosting.headers.find((rule) => rule.source === "**");
  if (!global) throw new Error('firebase.json has no "**" header rule');

  const headers = Object.fromEntries(
    global.headers.map(({ key, value }) => [key, value]),
  );
  if (rtdbEmulatorHost) {
    headers["Content-Security-Policy"] = headers[
      "Content-Security-Policy"
    ].replace(
      "connect-src",
      `connect-src http://${rtdbEmulatorHost} ws://${rtdbEmulatorHost}`,
    );
  }
  return headers;
}

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

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), swCacheBust()],
  resolve: {
    // A regex so the `?url` query survives the substitution.
    alias: [{ find: RTL_TEXT_PLUGIN, replacement: rtlTextPluginFile }],
  },
  server: {
    hmr: true,
  },
  preview: {
    headers: productionHeaders(
      loadEnv(mode, __dirname, "VITE_").VITE_RTDB_EMULATOR_HOST,
    ),
  },
  optimizeDeps: {
    include: [
      "mapbox-gl",
      "firebase/app",
      "firebase/auth",
      "firebase/database",
    ],
    // Imported as a `?url`, never as a module: pre-bundling it rewrote the
    // dev URL to a `.vite/deps` path that 404s, so `npm run dev` lost the
    // RTL plugin while production builds were fine.
    exclude: ["@mapbox/mapbox-gl-rtl-text"],
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
}));

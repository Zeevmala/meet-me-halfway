/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: true,
  },
  optimizeDeps: {
    include: ["mapbox-gl", "firebase/app", "firebase/auth", "firebase/database"],
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

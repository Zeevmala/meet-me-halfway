/**
 * Build plugin for public/sw.js. Its own module, not inline in vite.config.ts,
 * so a test can import it without loading Vite (esbuild refuses to load under
 * jsdom).
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import type { Plugin } from "vite";

/**
 * Replace __BUILD_HASH__ in the built sw.js so the cache version bumps with
 * every build.
 *
 * Reads the output directory Vite resolved, and fails the build when there is
 * nothing to stamp. It used to assume `dist/` and skip silently otherwise, and
 * an unstamped worker is the dev build (`IS_UNBUILT` in public/sw.js): in
 * production it unregisters itself, on every client, and says nothing.
 */
export function swCacheBust(): Plugin {
  let swPath = "";
  return {
    name: "sw-cache-bust",
    apply: "build",
    configResolved(config) {
      swPath = resolve(config.root, config.build.outDir, "sw.js");
    },
    closeBundle() {
      const content = readFileSync(swPath, "utf-8");
      const hash = createHash("md5")
        .update(Date.now().toString())
        .digest("hex")
        .slice(0, 8);
      const stamped = content.replace("__BUILD_HASH__", hash);
      if (stamped === content) {
        throw new Error(
          `sw-cache-bust: no __BUILD_HASH__ to stamp in ${swPath}`,
        );
      }
      writeFileSync(swPath, stamped);
    },
  };
}

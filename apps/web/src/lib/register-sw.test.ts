import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { swCacheBust } from "../../sw-cache-bust";

// ── Service worker + Cache API doubles ──

interface FakeRegistration {
  unregister: ReturnType<typeof vi.fn>;
}

function setup(opts: {
  prod: boolean;
  controlled?: boolean;
  registrations?: FakeRegistration[];
  cacheKeys?: string[];
}) {
  const registrations = opts.registrations ?? [];
  const deleted: string[] = [];
  const reload = vi.fn();

  vi.stubEnv("PROD", opts.prod);
  vi.stubEnv("DEV", !opts.prod);

  const update = vi.fn().mockResolvedValue(undefined);
  const register = vi.fn().mockResolvedValue({ update });
  const swListeners = new Map<string, () => void>();
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: opts.controlled ? {} : null,
      register,
      getRegistrations: vi.fn().mockResolvedValue(registrations),
      addEventListener: (event: string, cb: () => void) => {
        swListeners.set(event, cb);
      },
    },
  });

  const docListeners = new Map<string, () => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (event: string, cb: () => void) => {
      docListeners.set(event, cb);
    },
  };
  vi.stubGlobal("document", doc);

  vi.stubGlobal("caches", {
    keys: vi.fn().mockResolvedValue(opts.cacheKeys ?? []),
    delete: vi.fn(async (k: string) => {
      deleted.push(k);
      return true;
    }),
  });

  vi.stubGlobal("location", { reload });

  /** Play an event to the service worker container or the document. */
  const fire = (event: "controllerchange" | "visibilitychange") =>
    (event === "controllerchange" ? swListeners : docListeners).get(event)?.();

  return { register, update, deleted, reload, doc, fire };
}

/** Import the side-effect module fresh, then let its promise chain settle. */
async function loadModule() {
  vi.resetModules();
  await import("./register-sw");
  await vi.waitFor(() => {});
}

beforeEach(() => {
  vi.stubGlobal("window", {
    addEventListener: (event: string, cb: () => void) => {
      if (event === "load") cb();
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("register-sw", () => {
  it("registers the service worker in production", async () => {
    const { register, reload } = setup({ prod: true });
    await loadModule();

    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(reload).not.toHaveBeenCalled();
  });

  // sw.js claims open tabs and deletes the previous bundle's cache as it
  // activates. A tab left running that bundle 404s on its next lazy import
  // and keeps writing the schema it was built for.
  it("reloads when a new worker takes over a page another one served", async () => {
    const { reload, fire } = setup({ prod: true, controlled: true });
    await loadModule();

    fire("controllerchange");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the first worker claims the page", async () => {
    const { reload, fire } = setup({ prod: true, controlled: false });
    await loadModule();

    fire("controllerchange");

    expect(reload).not.toHaveBeenCalled();
  });

  // The browser only looks for a new worker on navigation, and a tab left
  // open never navigates — it would run the old bundle indefinitely.
  it("looks for a new worker when the tab comes back into view", async () => {
    const { update, doc, fire } = setup({ prod: true });
    await loadModule();

    doc.visibilityState = "hidden";
    fire("visibilitychange");
    expect(update).not.toHaveBeenCalled();

    doc.visibilityState = "visible";
    fire("visibilitychange");
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("does not register in development", async () => {
    const { register } = setup({ prod: false });
    await loadModule();

    expect(register).not.toHaveBeenCalled();
  });

  it("unregisters existing service workers in development", async () => {
    const reg = { unregister: vi.fn().mockResolvedValue(true) };
    setup({ prod: false, registrations: [reg] });
    await loadModule();

    expect(reg.unregister).toHaveBeenCalled();
  });

  it("deletes only mmh- caches in development", async () => {
    const { deleted } = setup({
      prod: false,
      cacheKeys: ["mmh-__BUILD_HASH__-shell", "mmh-abc123-shell", "other-app"],
    });
    await loadModule();

    expect(deleted).toEqual(["mmh-__BUILD_HASH__-shell", "mmh-abc123-shell"]);
  });

  it("reloads once when the page was served by a stale service worker", async () => {
    const { reload } = setup({ prod: false, controlled: true });
    await loadModule();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when no service worker controls the page", async () => {
    const { reload } = setup({ prod: false, controlled: false });
    await loadModule();

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("public/sw.js build-hash marker", () => {
  const sw = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf-8");

  // swCacheBust() in vite.config.ts substitutes with String.replace and a string
  // pattern, which rewrites only the first match. A second literal would survive
  // the build and leave production permanently in the "unbuilt" branch.
  it("contains exactly one literal __BUILD_HASH__ placeholder", () => {
    const literal = "__BUILD" + "_HASH__";
    expect(sw.split(literal).length - 1).toBe(1);
  });

  it("gates dev behaviour on the unsubstituted placeholder", () => {
    expect(sw).toContain("const IS_UNBUILT =");
    expect(sw).toContain("self.registration.unregister()");
  });
});

describe("firebase.json caching of the app shell", () => {
  interface HeaderRule {
    source: string;
    headers: { key: string; value: string }[];
  }
  const hosting = (
    JSON.parse(
      readFileSync(resolve(__dirname, "../../../../firebase.json"), "utf-8"),
    ) as { hosting: { headers: HeaderRule[] } }
  ).hosting;
  const cacheControl = (source: string) =>
    hosting.headers
      .find((rule) => rule.source === source)
      ?.headers.find((h) => h.key === "Cache-Control")?.value;

  // The worker's network-first fetch for the page goes through the HTTP
  // cache. Left to Hosting's defaults, a browser could reuse the previous
  // deploy's HTML, and with it the previous deploy's bundle.
  it.each(["/", "/index.html"])("revalidates %s on every load", (source) => {
    expect(cacheControl(source)).toBe("no-cache");
  });

  // Plugins and <base> injection are the two script vectors the rest of the
  // policy left open: `default-src` covers neither.
  it("allows no plugins and no foreign <base>", () => {
    const csp = hosting.headers
      .find((rule) => rule.source === "**")
      ?.headers.find((h) => h.key === "Content-Security-Policy")?.value;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("keeps hashed assets cacheable for good", () => {
    expect(cacheControl("**/*.@(js|css|woff2)")).toBe(
      "public,max-age=31536000,immutable",
    );
  });
});

describe("index.html social preview", () => {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf-8");
  const meta = (attr: string, name: string) =>
    new RegExp(`<meta ${attr}="${name}" content="([^"]+)"`).exec(html)?.[1];

  // Link previews (WhatsApp, Telegram, Facebook) do not resolve a relative
  // image, and sharing the session link is how every session starts.
  it("points at the preview image with an absolute URL on the app's origin", () => {
    const origin = new URL(meta("property", "og:url") ?? "").origin;
    for (const image of [
      meta("property", "og:image"),
      meta("name", "twitter:image"),
    ]) {
      expect(image && new URL(image).origin).toBe(origin);
    }
  });
});

describe("swCacheBust (build plugin)", () => {
  type Hooks = {
    configResolved(config: { root: string; build: { outDir: string } }): void;
    closeBundle(): void;
  };
  const plugin = () => swCacheBust() as unknown as Hooks;

  function outDir(name: string, sw: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "sw-cache-bust-"));
    mkdirSync(join(root, name));
    if (sw !== null) writeFileSync(join(root, name, "sw.js"), sw);
    return root;
  }

  // It assumed `dist/` and skipped quietly otherwise; an unstamped worker is
  // the dev build, which unregisters itself in production.
  it("stamps sw.js wherever the build actually wrote it", () => {
    const root = outDir(
      "custom-out",
      'const CACHE_VERSION = "mmh-__BUILD_HASH__";',
    );
    const p = plugin();

    p.configResolved({ root, build: { outDir: "custom-out" } });
    p.closeBundle();

    const stamped = readFileSync(join(root, "custom-out", "sw.js"), "utf-8");
    expect(stamped).toMatch(/^const CACHE_VERSION = "mmh-[0-9a-f]{8}";$/);
  });

  it("fails the build rather than ship a worker it could not stamp", () => {
    const missing = plugin();
    missing.configResolved({
      root: outDir("out", null),
      build: { outDir: "out" },
    });
    expect(() => missing.closeBundle()).toThrow();

    const unmarked = plugin();
    unmarked.configResolved({
      root: outDir("out", 'const CACHE_VERSION = "mmh-abc";'),
      build: { outDir: "out" },
    });
    expect(() => unmarked.closeBundle()).toThrow(/no __BUILD_HASH__/);
  });
});

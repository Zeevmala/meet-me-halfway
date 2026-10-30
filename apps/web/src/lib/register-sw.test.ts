import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

  it("keeps hashed assets cacheable for good", () => {
    expect(cacheControl("**/*.@(js|css|woff2)")).toBe(
      "public,max-age=31536000,immutable",
    );
  });
});

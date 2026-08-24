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

  const register = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    serviceWorker: {
      controller: opts.controlled ? {} : null,
      register,
      getRegistrations: vi.fn().mockResolvedValue(registrations),
    },
  });

  vi.stubGlobal("caches", {
    keys: vi.fn().mockResolvedValue(opts.cacheKeys ?? []),
    delete: vi.fn(async (k: string) => {
      deleted.push(k);
      return true;
    }),
  });

  vi.stubGlobal("location", { reload });

  return { register, deleted, reload };
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ── Mock firebase/app (stateful: getApps reflects prior initializeApp) ──
const apps: object[] = [];
const mockInitializeApp = vi.fn((config: unknown) => {
  const app = { config };
  apps.push(app);
  return app;
});

vi.mock("firebase/app", () => ({
  initializeApp: (config: unknown) => mockInitializeApp(config),
  getApps: () => apps,
}));

// ── Mock firebase/auth with sentinel persistence objects ──
const mockInitializeAuth = vi.fn();
const mockGetAuth = vi.fn();

vi.mock("firebase/auth", () => ({
  initializeAuth: (...args: unknown[]) => mockInitializeAuth(...args),
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  indexedDBLocalPersistence: { type: "indexedDB" },
  browserLocalPersistence: { type: "browserLocal" },
  inMemoryPersistence: { type: "inMemory" },
}));

// ── Mock firebase/database ──
vi.mock("firebase/database", () => ({
  getDatabase: () => ({ _db: true }),
}));

// ── Mock firebase/app-check ──
const mockInitializeAppCheck = vi.fn();
vi.mock("firebase/app-check", () => ({
  initializeAppCheck: (...args: unknown[]) => mockInitializeAppCheck(...args),
  ReCaptchaEnterpriseProvider: class {
    siteKey: string;
    constructor(siteKey: string) {
      this.siteKey = siteKey;
    }
  },
}));

// ── Mock Sentry ──
vi.mock("@sentry/react", () => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
}));

// Module-level singletons in useFirebase persist between imports, so each
// test resets the module registry and re-imports a fresh copy.
async function loadUseFirebase() {
  const mod = await import("./useFirebase");
  return mod.useFirebase;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  apps.length = 0;
  mockInitializeAuth.mockImplementation(() => ({ kind: "auth-persistent" }));
  mockGetAuth.mockReturnValue({ kind: "auth-existing" });
  mockInitializeAppCheck.mockReturnValue({ kind: "app-check" });
  // Keep App Check on the skip path unless a test opts in.
  vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("useFirebase", () => {
  it("initializes auth once with the full persistence fallback chain", async () => {
    const useFirebase = await loadUseFirebase();
    const { result } = renderHook(() => useFirebase());

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockInitializeAuth).toHaveBeenCalledTimes(1);
    const [, options] = mockInitializeAuth.mock.calls[0];
    expect(options).toEqual({
      persistence: [
        { type: "indexedDB" },
        { type: "browserLocal" },
        { type: "inMemory" },
      ],
    });
    expect(result.current.auth).toEqual({ kind: "auth-persistent" });
    expect(result.current.appCheck).toBeNull();
  });

  it("falls back to in-memory persistence when persistent init throws", async () => {
    mockInitializeAuth
      .mockImplementationOnce(() => {
        throw new Error("SecurityError: storage access blocked");
      })
      .mockImplementationOnce(() => ({ kind: "auth-memory" }));

    const useFirebase = await loadUseFirebase();
    const { result } = renderHook(() => useFirebase());

    expect(mockInitializeAuth).toHaveBeenCalledTimes(2);
    const [, options] = mockInitializeAuth.mock.calls[1];
    expect(options).toEqual({ persistence: { type: "inMemory" } });
    expect(result.current.auth).toEqual({ kind: "auth-memory" });
  });

  it("falls back to getAuth when both initializeAuth calls throw", async () => {
    mockInitializeAuth.mockImplementation(() => {
      throw new Error("auth/already-initialized");
    });

    const useFirebase = await loadUseFirebase();
    const { result } = renderHook(() => useFirebase());

    expect(mockGetAuth).toHaveBeenCalledTimes(1);
    expect(result.current.auth).toEqual({ kind: "auth-existing" });
  });

  it("reuses the same auth instance across hook consumers", async () => {
    const useFirebase = await loadUseFirebase();
    const first = renderHook(() => useFirebase());
    const second = renderHook(() => useFirebase());

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockInitializeAuth).toHaveBeenCalledTimes(1);
    expect(second.result.current.auth).toBe(first.result.current.auth);
  });

  it("skips App Check init when no site key is configured", async () => {
    const useFirebase = await loadUseFirebase();
    renderHook(() => useFirebase());

    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
  });

  it("skips App Check when the site key is set but the app id is missing", async () => {
    vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "test-site-key");

    const useFirebase = await loadUseFirebase();
    const { result } = renderHook(() => useFirebase());

    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
    expect(result.current.appCheck).toBeNull();
  });

  it("continues with null appCheck when App Check init throws", async () => {
    vi.stubEnv("VITE_RECAPTCHA_SITE_KEY", "test-site-key");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:123:web:abc");
    mockInitializeAppCheck.mockImplementation(() => {
      throw new Error("reCAPTCHA script blocked");
    });

    const useFirebase = await loadUseFirebase();
    const { result } = renderHook(() => useFirebase());

    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(result.current.appCheck).toBeNull();
    expect(result.current.db).toEqual({ _db: true });
    expect(result.current.auth).toEqual({ kind: "auth-persistent" });
  });
});

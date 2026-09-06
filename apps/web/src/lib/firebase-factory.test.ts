import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFirebaseServices } from "./firebase-factory";
import type { AppConfig } from "./config";

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

vi.mock("firebase/database", () => ({
  getDatabase: () => ({ _db: true }),
}));

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

vi.mock("@sentry/react", () => ({
  setTag: vi.fn(),
  captureMessage: vi.fn(),
}));

/**
 * Config is an argument now, so these tests neither stub `import.meta.env` nor
 * reset the module registry between cases — the previous suite had to do both,
 * because construction happened in module-level state on first import.
 */
function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mapboxToken: "pk.test",
    places: null,
    firebase: {
      apiKey: "key",
      authDomain: "test.firebaseapp.com",
      databaseURL: "https://test.firebaseio.com",
      projectId: "test",
      appId: undefined,
    },
    recaptchaSiteKey: null,
    sentryDsn: null,
    ...overrides,
  };
}

function withAppCheck(appId: string | undefined, siteKey: string | null) {
  return config({
    firebase: { ...config().firebase, appId },
    recaptchaSiteKey: siteKey,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  apps.length = 0;
  mockInitializeAuth.mockImplementation(() => ({ kind: "auth-persistent" }));
  mockGetAuth.mockReturnValue({ kind: "auth-existing" });
  mockInitializeAppCheck.mockReturnValue({ kind: "app-check" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFirebaseServices", () => {
  it("initializes auth with the full persistence fallback chain", () => {
    const services = createFirebaseServices(config());

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
    expect(services.auth).toEqual({ kind: "auth-persistent" });
    expect(services.appCheck).toBeNull();
  });

  it("passes the configured Firebase options through to initializeApp", () => {
    createFirebaseServices(withAppCheck("1:123:web:abc", null));

    expect(mockInitializeApp).toHaveBeenCalledWith({
      apiKey: "key",
      authDomain: "test.firebaseapp.com",
      databaseURL: "https://test.firebaseio.com",
      projectId: "test",
      appId: "1:123:web:abc",
    });
  });

  it("falls back to in-memory persistence when persistent init throws", () => {
    mockInitializeAuth
      .mockImplementationOnce(() => {
        throw new Error("SecurityError: storage access blocked");
      })
      .mockImplementationOnce(() => ({ kind: "auth-memory" }));

    const services = createFirebaseServices(config());

    expect(mockInitializeAuth).toHaveBeenCalledTimes(2);
    const [, options] = mockInitializeAuth.mock.calls[1];
    expect(options).toEqual({ persistence: { type: "inMemory" } });
    expect(services.auth).toEqual({ kind: "auth-memory" });
  });

  it("falls back to getAuth when both initializeAuth calls throw", () => {
    mockInitializeAuth.mockImplementation(() => {
      throw new Error("auth/already-initialized");
    });

    const services = createFirebaseServices(config());

    expect(mockGetAuth).toHaveBeenCalledTimes(1);
    expect(services.auth).toEqual({ kind: "auth-existing" });
  });

  it("reuses an already-initialized app rather than creating a second", () => {
    // Vite HMR re-evaluates modules; the SDK throws on a duplicate app.
    const first = createFirebaseServices(config());
    const second = createFirebaseServices(config());

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(second.app).toBe(first.app);
  });

  it("skips App Check when no site key is configured", () => {
    createFirebaseServices(config());
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
  });

  it("skips App Check when the site key is set but the app id is missing", () => {
    // Attestation posts to /apps/{appId}/… and can only 400 without it, so
    // half-configured must mean off, not broken for every client.
    const services = createFirebaseServices(
      withAppCheck(undefined, "test-site-key"),
    );

    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
    expect(services.appCheck).toBeNull();
  });

  it("initializes App Check when both the site key and app id are present", () => {
    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
    );

    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(services.appCheck).toEqual({ kind: "app-check" });
  });

  it("continues with null appCheck when App Check init throws", () => {
    mockInitializeAppCheck.mockImplementation(() => {
      throw new Error("reCAPTCHA script blocked");
    });

    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
    );

    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(services.appCheck).toBeNull();
    expect(services.db).toEqual({ _db: true });
    expect(services.auth).toEqual({ kind: "auth-persistent" });
  });
});

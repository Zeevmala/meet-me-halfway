import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  APP_CHECK_TIMEOUT_MS,
  createFirebaseServices,
  primeAppCheck,
} from "./firebase-factory";
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

// A spy, not a literal: the ordering test below compares when this ran
// against when App Check was initialized.
const mockGetDatabase = vi.fn(() => ({ _db: true }));
vi.mock("firebase/database", () => ({
  getDatabase: () => mockGetDatabase(),
}));

const mockInitializeAppCheck = vi.fn();
const mockGetToken = vi.fn();
vi.mock("firebase/app-check", () => ({
  initializeAppCheck: (...args: unknown[]) => mockInitializeAppCheck(...args),
  getToken: (...args: unknown[]) => mockGetToken(...args),
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
  mockGetToken.mockResolvedValue({ token: "attestation-token" });
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

  it("initializes App Check before it builds the Database handle", () => {
    // Ordering, not decoration. RTDB sends the App Check token when it
    // establishes its socket, so anything that can lead to a connection must
    // be constructed after attestation is registered on the app. The previous
    // object literal evaluated `db: getDatabase(app)` first, because property
    // initialisers run in source order.
    createFirebaseServices(withAppCheck("1:123:web:abc", "test-site-key"));

    expect(mockInitializeAppCheck.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetDatabase.mock.invocationCallOrder[0],
    );
  });

  it("primes attestation without waiting for it", async () => {
    // The fetch is in flight when the factory returns — that is what keeps it
    // off the first-paint path — and the promise carries the outcome.
    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
    );

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    await expect(services.appCheckReady).resolves.toEqual({
      ok: true,
      reason: "token",
      latencyMs: expect.any(Number),
    });
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

/**
 * The invariant every case here shares: **it never rejects.**
 *
 * Attestation sits in front of the first RTDB subscription, so a rejection
 * would not merely lose a token — it would leave the app never connecting at
 * all. Degrade, never block.
 */
describe("primeAppCheck", () => {
  it("resolves no-appcheck immediately when attestation is unconfigured", async () => {
    await expect(primeAppCheck(null)).resolves.toEqual({
      ok: false,
      reason: "no-appcheck",
    });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("reports the token and how long it took", async () => {
    const outcome = await primeAppCheck({ kind: "app-check" } as never);

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBe("token");
    if (outcome.ok) expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports error rather than rejecting when reCAPTCHA is blocked", async () => {
    mockGetToken.mockRejectedValue(new Error("reCAPTCHA script blocked"));

    await expect(
      primeAppCheck({ kind: "app-check" } as never),
    ).resolves.toEqual({ ok: false, reason: "error" });
  });

  it("gives up at the budget when the token never arrives", async () => {
    vi.useFakeTimers();
    // A hang, not a rejection: the in-app-browser case, where the reCAPTCHA
    // fetch neither resolves nor fails.
    mockGetToken.mockReturnValue(new Promise(() => {}));

    const pending = primeAppCheck({ kind: "app-check" } as never);
    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    vi.useRealTimers();
  });

  it("does not fire the timeout once a token has arrived", async () => {
    vi.useFakeTimers();

    const outcome = await primeAppCheck({ kind: "app-check" } as never);
    // Past the budget: a live timer here would mean a dangling handle, and in
    // a shorter-lived context an unhandled resolve after teardown.
    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS * 2);

    expect(outcome.reason).toBe("token");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

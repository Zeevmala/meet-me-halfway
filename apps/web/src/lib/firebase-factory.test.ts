import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Sentry from "@sentry/react";
import {
  APP_CHECK_TIMEOUT_MS,
  createFirebaseServices,
  loadRecaptchaEnterprise,
  parseEmulatorHost,
  primeAppCheck,
  RECAPTCHA_ENTERPRISE_SCRIPT,
  readWebSocketHistory,
  startAppCheck,
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

// A spy, not a literal, so a case can tell whether it ran.
const mockGetDatabase = vi.fn(() => ({ _db: true }));
const mockConnectDatabaseEmulator = vi.fn();
const mockForceWebSockets = vi.fn();
vi.mock("firebase/database", () => ({
  getDatabase: () => mockGetDatabase(),
  connectDatabaseEmulator: (...args: unknown[]) =>
    mockConnectDatabaseEmulator(...args),
  forceWebSockets: () => mockForceWebSockets(),
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
    release: null,
    rtdbEmulatorHost: null,
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
    expect(services.appCheckConfigured).toBe(false);
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

  it("skips App Check when no site key is configured", async () => {
    const services = createFirebaseServices(config());

    expect(services.appCheckConfigured).toBe(false);
    await expect(services.appCheckReady).resolves.toEqual({
      ok: false,
      reason: "no-appcheck",
    });
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
  });

  it("skips App Check when the site key is set but the app id is missing", async () => {
    // Attestation posts to /apps/{appId}/… and can only 400 without it, so
    // half-configured must mean off, not broken for every client.
    const loadRecaptcha = vi.fn().mockResolvedValue(true);
    const services = createFirebaseServices(
      withAppCheck(undefined, "test-site-key"),
      loadRecaptcha,
    );

    expect(services.appCheckConfigured).toBe(false);
    await expect(services.appCheckReady).resolves.toMatchObject({
      reason: "no-appcheck",
    });
    expect(loadRecaptcha).not.toHaveBeenCalled();
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
  });

  it("initializes App Check once reCAPTCHA is ready, and primes its token", async () => {
    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
      async () => true,
    );

    expect(services.appCheckConfigured).toBe(true);
    await expect(services.appCheckReady).resolves.toEqual({
      ok: true,
      reason: "token",
      latencyMs: expect.any(Number),
    });
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(mockGetToken).toHaveBeenCalledTimes(1);
  });

  // The SDK loads reCAPTCHA with an onload and nothing else, and Auth and the
  // Database wait on its token: initialised on a script that never loads, the
  // page sat on "Connecting…" for good, enforcement on or off.
  it("does not initialize App Check before reCAPTCHA has said it is ready", async () => {
    let ready = (_ready: boolean): void => {};
    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
      () =>
        new Promise<boolean>((resolve) => {
          ready = resolve;
        }),
    );

    // The handles exist, and the page can go on; attestation has not begun.
    expect(services.db).toEqual({ _db: true });
    expect(services.auth).toEqual({ kind: "auth-persistent" });
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();

    ready(true);
    await services.appCheckReady;
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
  });

  it("leaves App Check off, and says so, when reCAPTCHA does not load", async () => {
    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
      async () => false,
    );

    await expect(services.appCheckReady).resolves.toEqual({
      ok: false,
      reason: "blocked",
    });
    expect(mockInitializeAppCheck).not.toHaveBeenCalled();
    expect(Sentry.setTag).toHaveBeenCalledWith("appcheck_outcome", "blocked");
    expect(services.db).toEqual({ _db: true });
  });

  it("goes on unattested when App Check init throws", async () => {
    mockInitializeAppCheck.mockImplementation(() => {
      throw new Error("reCAPTCHA refused");
    });

    const services = createFirebaseServices(
      withAppCheck("1:123:web:abc", "test-site-key"),
      async () => true,
    );

    await expect(services.appCheckReady).resolves.toEqual({
      ok: false,
      reason: "error",
    });
    expect(mockInitializeAppCheck).toHaveBeenCalledTimes(1);
    expect(services.db).toEqual({ _db: true });
    expect(services.auth).toEqual({ kind: "auth-persistent" });
  });

  it("never points the Database handle at an emulator unless configured", () => {
    createFirebaseServices(config());

    expect(mockConnectDatabaseEmulator).not.toHaveBeenCalled();
  });

  it("points the Database handle at the configured emulator", () => {
    const services = createFirebaseServices(
      config({ rtdbEmulatorHost: "127.0.0.1:9000" }),
    );

    expect(mockConnectDatabaseEmulator).toHaveBeenCalledWith(
      services.db,
      "127.0.0.1",
      9000,
    );
  });

  // The SDK's fallback, JSONP long-polling, is script the CSP refuses, and a
  // browser whose last socket died young is routed to it on every connection
  // after — never connecting, never upgrading, never clearing the flag that
  // put it there. Forced before the handle exists, so before any connection.
  it("forces WebSockets before it builds the Database handle", () => {
    createFirebaseServices(config());

    expect(mockForceWebSockets).toHaveBeenCalledTimes(1);
    expect(mockForceWebSockets.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetDatabase.mock.invocationCallOrder[0],
    );
  });

  it("tags reports with the WebSocket history the SDK would have read", () => {
    window.localStorage.setItem("firebase:previous_websocket_failure", "true");
    try {
      createFirebaseServices(config());
    } finally {
      window.localStorage.removeItem("firebase:previous_websocket_failure");
    }

    expect(Sentry.setTag).toHaveBeenCalledWith(
      "rtdb_ws_history",
      "previously-failed",
    );
  });
});

describe("readWebSocketHistory", () => {
  const storageWith = (value: string | null) => () =>
    ({ getItem: () => value }) as unknown as Storage;

  it("reads a set flag as previously-failed", () => {
    expect(readWebSocketHistory(storageWith("true"))).toBe("previously-failed");
  });

  it("reads no flag as clean", () => {
    expect(readWebSocketHistory(storageWith(null))).toBe("clean");
  });

  // The SDK falls back to in-memory storage here and treats that as a failed
  // socket too, so this is the long-polling trap as well — just a different door.
  it("reports storage that throws as storage-blocked", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    expect(readWebSocketHistory(blocked)).toBe("storage-blocked");
  });
});

describe("parseEmulatorHost", () => {
  it("splits host and port", () => {
    expect(parseEmulatorHost("localhost:9000")).toEqual({
      host: "localhost",
      port: 9000,
    });
  });

  it.each(["127.0.0.1", ":9000", "127.0.0.1:", "127.0.0.1:abc"])(
    "rejects %j rather than guessing",
    (value) => {
      expect(() => parseEmulatorHost(value)).toThrow(/host:port/);
    },
  );
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

describe("startAppCheck", () => {
  // Never rejects: a device that cannot attest goes on unattested.
  it("reports an error rather than rejecting when the loader throws", async () => {
    const outcome = await startAppCheck({} as never, "test-site-key", () =>
      Promise.reject(new Error("boom")),
    );

    expect(outcome).toEqual({ ok: false, reason: "error" });
  });

  // One budget for the whole of it: a script that took most of it leaves
  // the token only what is left.
  it("gives the token only what the script left of the budget", async () => {
    vi.useFakeTimers();
    mockGetToken.mockReturnValue(new Promise(() => {}));
    const pending = startAppCheck({} as never, "test-site-key", async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, APP_CHECK_TIMEOUT_MS - 1_000),
      );
      return true;
    });

    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    vi.useRealTimers();
  });
});

describe("loadRecaptchaEnterprise", () => {
  /** A window of our own: jsdom's document, and a `grecaptcha` we control. */
  function fakeWindow(grecaptcha?: unknown) {
    const win = { document, grecaptcha } as unknown as Window & {
      grecaptcha?: unknown;
    };
    return win;
  }

  function lastScript(): HTMLScriptElement | undefined {
    const scripts = document.head.querySelectorAll("script");
    return scripts[scripts.length - 1];
  }

  afterEach(() => {
    document.head.querySelectorAll("script").forEach((s) => s.remove());
  });

  it("is ready at once when reCAPTCHA is already on the page and says so", async () => {
    const win = fakeWindow({ enterprise: { ready: (f: () => void) => f() } });

    await expect(loadRecaptchaEnterprise(1_000, win)).resolves.toBe(true);
    expect(lastScript()).toBeUndefined();
  });

  it("loads the script, and is ready once reCAPTCHA says so", async () => {
    const win = fakeWindow();
    const loading = loadRecaptchaEnterprise(1_000, win);
    const script = lastScript();
    expect(script?.src).toBe(RECAPTCHA_ENTERPRISE_SCRIPT);

    win.grecaptcha = { enterprise: { ready: (f: () => void) => f() } };
    script?.onload?.(new Event("load"));

    await expect(loading).resolves.toBe(true);
  });

  it("is not ready when the script fails to load", async () => {
    const win = fakeWindow();
    const loading = loadRecaptchaEnterprise(1_000, win);

    lastScript()?.onerror?.(new Event("error"));

    await expect(loading).resolves.toBe(false);
  });

  it("is not ready when the script loads without reCAPTCHA in it", async () => {
    const win = fakeWindow();
    const loading = loadRecaptchaEnterprise(1_000, win);

    lastScript()?.onload?.(new Event("load"));

    await expect(loading).resolves.toBe(false);
  });

  // Neither loaded nor failed: the network that drops the request on the
  // floor. The page waits only as long as the budget.
  it("gives up at the budget when the script never answers", async () => {
    vi.useFakeTimers();
    const loading = loadRecaptchaEnterprise(APP_CHECK_TIMEOUT_MS, fakeWindow());

    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS);

    await expect(loading).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("gives up at the budget when reCAPTCHA loads but is never ready", async () => {
    vi.useFakeTimers();
    const win = fakeWindow({ enterprise: { ready: () => {} } });
    const loading = loadRecaptchaEnterprise(APP_CHECK_TIMEOUT_MS, win);

    await vi.advanceTimersByTimeAsync(APP_CHECK_TIMEOUT_MS);

    await expect(loading).resolves.toBe(false);
    vi.useRealTimers();
  });
});

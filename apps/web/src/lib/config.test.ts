import { describe, it, expect } from "vitest";
import { createAppConfig, validateAppConfig } from "./config";
import type { AppConfig } from "./config";

function complete(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mapboxToken: "pk.test",
    places: { apiKey: "places-key" },
    firebase: {
      apiKey: "key",
      authDomain: "test.firebaseapp.com",
      databaseURL: "https://test.firebaseio.com",
      projectId: "test",
      appId: "1:123:web:abc",
    },
    recaptchaSiteKey: "site-key",
    sentryDsn: null,
    ...overrides,
  };
}

describe("validateAppConfig", () => {
  it("accepts a complete configuration", () => {
    expect(() => validateAppConfig(complete())).not.toThrow();
  });

  it("accepts a configuration without the optional Places key", () => {
    expect(() => validateAppConfig(complete({ places: null }))).not.toThrow();
  });

  it("accepts every App Check configuration, including broken ones", () => {
    // App Check is optional and must never stop the app loading. Whether its
    // two variables agree is a deployment property, checked while the bundle is
    // built (build/app-check-pairing.ts) so a misconfiguration fails CI rather
    // than blanking the page for every user. A rule here could not do that:
    // this runs in the browser, and `vite build` never executes it.
    const off = complete({
      recaptchaSiteKey: null,
      firebase: { ...complete().firebase, appId: undefined },
    });
    const halfConfigured = complete({
      firebase: { ...complete().firebase, appId: undefined },
    });
    const idOnly = complete({ recaptchaSiteKey: null });

    for (const config of [off, halfConfigured, idOnly]) {
      expect(() => validateAppConfig(config)).not.toThrow();
    }
  });

  it("names every missing variable at once", () => {
    let message = "";
    try {
      validateAppConfig(
        complete({
          mapboxToken: "",
          recaptchaSiteKey: null,
          firebase: { ...complete().firebase, apiKey: "", projectId: "" },
        }),
      );
    } catch (thrown) {
      message = thrown instanceof Error ? thrown.message : String(thrown);
    }

    expect(message).toContain("VITE_MAPBOX_TOKEN");
    expect(message).toContain("VITE_FIREBASE_API_KEY");
    expect(message).toContain("VITE_FIREBASE_PROJECT_ID");
    expect(message).not.toContain("VITE_FIREBASE_AUTH_DOMAIN");
  });
});

describe("createAppConfig", () => {
  it("reads a shape the validator understands", () => {
    const config = createAppConfig();

    expect(typeof config.mapboxToken).toBe("string");
    expect(config.places === null || typeof config.places.apiKey).toBeTruthy();
    expect(typeof config.firebase.projectId).toBe("string");
  });

  it("models an absent optional value as null, never an empty string", () => {
    // `places: { apiKey: "" }` would read as "enabled" at every call site that
    // only checks for the object — which is how three separate reads of the
    // same variable managed to disagree about whether the feature was on.
    const config = createAppConfig();

    expect(config.places?.apiKey).not.toBe("");
    expect(config.recaptchaSiteKey).not.toBe("");
    expect(config.sentryDsn).not.toBe("");
    expect(config.firebase.appId).not.toBe("");
  });
});

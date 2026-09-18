import { describe, it, expect } from "vitest";
import { appCheckPairingError } from "./app-check-pairing";

const SITE_KEY = "6Lxxxxxxxxxxxxxxxxxxxxxxxxx";
const APP_ID = "1:000000000000:web:abc";

describe("appCheckPairingError", () => {
  it("rejects a site key without an appId", () => {
    // #62: attestation posts to /apps/undefined and 400s on every client while
    // the deployment reports itself configured.
    const error = appCheckPairingError({ VITE_RECAPTCHA_SITE_KEY: SITE_KEY });

    expect(error).toContain("VITE_FIREBASE_APP_ID");
    expect(error).toContain("400");
  });

  it("treats an empty site key as unset, the way Vite does", () => {
    expect(
      appCheckPairingError({
        VITE_RECAPTCHA_SITE_KEY: "",
        VITE_FIREBASE_APP_ID: "",
      }),
    ).toBeNull();
  });

  it("accepts App Check fully configured", () => {
    expect(
      appCheckPairingError({
        VITE_RECAPTCHA_SITE_KEY: SITE_KEY,
        VITE_FIREBASE_APP_ID: APP_ID,
      }),
    ).toBeNull();
  });

  it("accepts App Check switched off entirely", () => {
    // What .env.emulator and the production build both do.
    expect(appCheckPairingError({})).toBeNull();
  });

  it("accepts an appId on its own", () => {
    // Inert without a site key, and keeping it legal is what makes re-enabling
    // attestation a one-secret change rather than two.
    expect(appCheckPairingError({ VITE_FIREBASE_APP_ID: APP_ID })).toBeNull();
  });
});

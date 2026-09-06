/**
 * The one module that reads application configuration out of the environment.
 *
 * It was previously read wherever it happened to be needed: the Places key in
 * three places (`graph/ports.ts`, `lib/places-api.ts`, `LiveMidpointPage.tsx`),
 * the Mapbox token in two (`components/LiveMap.tsx`, `lib/directions-api.ts`),
 * the reCAPTCHA key in two, and the Firebase block in `hooks/useFirebase.ts` —
 * while `lib/env.ts` validated five of the six variables the app actually
 * requires. Nothing could be substituted in a test, so exercising the venue
 * path meant mocking modules rather than passing a value.
 *
 * `import.meta.env.VITE_*` is read with **static** property access throughout:
 * Vite only performs the build-time substitution for literal accesses, so
 * `import.meta.env[name]` would silently be `undefined` in a production build.
 *
 * `import.meta.env.DEV` / `PROD` / `MODE` are build-mode flags rather than
 * application configuration; they stay at their point of use.
 */

/** Optional feature: absent key means venue search is off, not broken. */
export interface PlacesConfig {
  readonly apiKey: string;
}

export interface FirebaseConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly databaseURL: string;
  readonly projectId: string;
  /**
   * Required for App Check: the attestation exchange posts to
   * `/apps/{appId}/…` and returns HTTP 400 for every client without it.
   */
  readonly appId: string | undefined;
}

export interface AppConfig {
  readonly mapboxToken: string;
  readonly places: PlacesConfig | null;
  readonly firebase: FirebaseConfig;
  readonly recaptchaSiteKey: string | null;
  readonly sentryDsn: string | null;
}

function orNull(value: string | undefined): string | null {
  return value !== undefined && value !== "" ? value : null;
}

export function createAppConfig(): AppConfig {
  const placesKey = orNull(import.meta.env.VITE_GOOGLE_PLACES_API_KEY);
  return {
    mapboxToken: import.meta.env.VITE_MAPBOX_TOKEN ?? "",
    places: placesKey === null ? null : { apiKey: placesKey },
    firebase: {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
      databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL ?? "",
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
      appId: orNull(import.meta.env.VITE_FIREBASE_APP_ID) ?? undefined,
    },
    recaptchaSiteKey: orNull(import.meta.env.VITE_RECAPTCHA_SITE_KEY),
    sentryDsn: orNull(import.meta.env.VITE_SENTRY_DSN),
  };
}

/**
 * Fail fast, before React renders, on anything the app cannot run without.
 *
 * `VITE_RECAPTCHA_SITE_KEY` is included: the README and CLAUDE.md both list it
 * as required, and its absence silently disables App Check, so a deployment
 * missing it looks healthy while being unattested. The previous `validateEnv`
 * omitted it.
 *
 * @throws with every missing variable named at once — finding them one build
 *   at a time is the worse experience.
 */
export function validateAppConfig(config: AppConfig): void {
  const missing: string[] = [];
  if (config.mapboxToken === "") missing.push("VITE_MAPBOX_TOKEN");
  if (config.firebase.apiKey === "") missing.push("VITE_FIREBASE_API_KEY");
  if (config.firebase.authDomain === "") {
    missing.push("VITE_FIREBASE_AUTH_DOMAIN");
  }
  if (config.firebase.databaseURL === "") {
    missing.push("VITE_FIREBASE_DATABASE_URL");
  }
  if (config.firebase.projectId === "") {
    missing.push("VITE_FIREBASE_PROJECT_ID");
  }
  if (config.recaptchaSiteKey === null) {
    missing.push("VITE_RECAPTCHA_SITE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing
        .map((name) => `  • ${name}`)
        .join("\n")}\n\nCopy .env.example → .env and fill in the values.`,
    );
  }
}

/**
 * Process-wide configuration.
 *
 * Injected explicitly everywhere it can be (see `lib/services.ts`). This
 * binding exists for the one case that cannot take an argument: `mapboxgl`
 * exposes a single global `accessToken`, not a per-instance one.
 */
export const APP_CONFIG: AppConfig = createAppConfig();

const REQUIRED_VARS = [
  "VITE_MAPBOX_TOKEN",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_DATABASE_URL",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_RECAPTCHA_SITE_KEY",
] as const;

/** Validate all required VITE_* env vars exist before React renders. */
export function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((key) => !import.meta.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((v) => `  • ${v}`).join("\n")}\n\nCopy .env.example → .env and fill in the values.`,
    );
  }
}

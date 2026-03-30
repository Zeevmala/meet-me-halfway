/**
 * Validate all required VITE_* env vars exist before React renders.
 * Uses static access (import.meta.env.VITE_X) because Vite only replaces
 * these at build time — dynamic access (import.meta.env[key]) returns undefined.
 */
export function validateEnv(): void {
  const entries: [string, string | undefined][] = [
    ["VITE_MAPBOX_TOKEN", import.meta.env.VITE_MAPBOX_TOKEN],
    ["VITE_FIREBASE_API_KEY", import.meta.env.VITE_FIREBASE_API_KEY],
    ["VITE_FIREBASE_AUTH_DOMAIN", import.meta.env.VITE_FIREBASE_AUTH_DOMAIN],
    ["VITE_FIREBASE_DATABASE_URL", import.meta.env.VITE_FIREBASE_DATABASE_URL],
    ["VITE_FIREBASE_PROJECT_ID", import.meta.env.VITE_FIREBASE_PROJECT_ID],
  ];

  const missing = entries.filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((v) => `  • ${v}`).join("\n")}\n\nCopy .env.example → .env and fill in the values.`,
    );
  }
}

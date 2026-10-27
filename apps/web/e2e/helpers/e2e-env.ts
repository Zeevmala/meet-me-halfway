import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

/** `apps/web`, where `.env.e2e` lives. */
const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The same `.env.e2e` the bundle under test was built from, so the suite and
 * the app cannot disagree about which emulator or namespace they are using.
 */
const env = loadEnv("e2e", WEB_ROOT, "VITE_");

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is missing from apps/web/.env.e2e`);
  return value;
}

export const PROJECT_ID = required("VITE_FIREBASE_PROJECT_ID");
export const RTDB_EMULATOR_HOST = required("VITE_RTDB_EMULATOR_HOST");

/** RTDB namespaces are the database URL's first host label. */
export const RTDB_NAMESPACE = new URL(
  required("VITE_FIREBASE_DATABASE_URL"),
).hostname.split(".")[0];

export const RULES_PATH = fileURLToPath(
  new URL("../../../../infra/database.rules.json", import.meta.url),
);

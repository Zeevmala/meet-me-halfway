import { readFileSync } from "node:fs";
import {
  RTDB_EMULATOR_HOST,
  RTDB_NAMESPACE,
  RULES_PATH,
} from "./helpers/e2e-env";

/**
 * Load the deployed security rules into the emulator namespace the e2e build
 * talks to.
 *
 * Explicit rather than left to `firebase.json`: the suite then exercises
 * `infra/database.rules.json` against the real client whichever way the
 * emulator was started, which is the pairing the 2026-09-11 outage broke.
 */
export default async function globalSetup(): Promise<void> {
  const url = `http://${RTDB_EMULATOR_HOST}/.settings/rules.json?ns=${RTDB_NAMESPACE}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { Authorization: "Bearer owner" },
      body: readFileSync(RULES_PATH, "utf8"),
    });
  } catch (cause) {
    throw new Error(
      `No Realtime Database emulator at ${RTDB_EMULATOR_HOST}. From the repo ` +
        "root, run the suite under one:\n" +
        "  npx -y firebase-tools@15.29.0 emulators:exec --only database " +
        '--project demo-meet-me-halfway "npm --prefix apps/web run test:e2e"',
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Loading rules into the emulator failed: HTTP ${response.status} ` +
        (await response.text()),
    );
  }
}

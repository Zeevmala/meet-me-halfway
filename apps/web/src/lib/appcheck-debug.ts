/**
 * Side-effect module: sets Firebase App Check debug token flag.
 * Must be imported BEFORE any firebase/app-check import (ES module hoisting).
 */
if (import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

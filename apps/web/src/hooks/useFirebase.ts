/**
 * Firebase handles, read from the injected services.
 *
 * This used to *be* the singleton: module-level `authInstance` and
 * `appCheckInstance`, with App Check initialisation as a hidden side effect of
 * a getter. Construction now lives in `lib/firebase-factory.ts` and happens
 * once at the composition root; this is a lookup, nothing more.
 */
import { useServices } from "../components/ServicesProvider";
import type { FirebaseServices } from "../lib/firebase-factory";

export type { FirebaseServices };

export function useFirebase(): FirebaseServices {
  return useServices().firebase;
}

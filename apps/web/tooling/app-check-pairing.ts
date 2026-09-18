/**
 * The one App Check invariant, checked while the bundle is built.
 *
 * App Check needs both `VITE_RECAPTCHA_SITE_KEY` and `VITE_FIREBASE_APP_ID`: the
 * attestation exchange posts to `/apps/{appId}/…` and can only return HTTP 400
 * without the app resource. Shipping the site key alone is what happened in #62
 * — every client failed attestation while the deployment looked configured, and
 * `createAppCheck`'s answer is a `console.warn` nobody reads.
 *
 * This lives at build time rather than in `validateAppConfig` on purpose.
 * `validateAppConfig` runs in the browser during `main.tsx` module evaluation,
 * so a rule added there would not fail CI — `vite build` never executes it — and
 * would instead blank the page for every user of a misconfigured deploy. That is
 * strictly worse than the warning it would replace. Whether two deployment
 * variables agree is knowable when the bundle is produced, so it is settled
 * there, where it stops a release rather than a user.
 *
 * The reverse pairing is deliberately legal: an appId with no site key means App
 * Check is simply off, the id is inert without Analytics, and keeping it valid
 * is what makes turning attestation back on a one-secret change.
 */

export interface AppCheckEnv {
  readonly VITE_RECAPTCHA_SITE_KEY?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

/** Vite treats an unset variable and an empty one identically; so does this. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * @returns the error message for a half-configured App Check, or `null` when the
 *   configuration is coherent (both set, or neither).
 */
export function appCheckPairingError(env: AppCheckEnv): string | null {
  if (
    present(env.VITE_RECAPTCHA_SITE_KEY) &&
    !present(env.VITE_FIREBASE_APP_ID)
  ) {
    return (
      "VITE_RECAPTCHA_SITE_KEY is set but VITE_FIREBASE_APP_ID is not.\n" +
      "App Check needs both: the attestation exchange posts to /apps/{appId}/… " +
      "and returns HTTP 400 for every client without it, so this bundle would " +
      "fail attestation on every device while reporting itself configured.\n\n" +
      "Set VITE_FIREBASE_APP_ID, or unset VITE_RECAPTCHA_SITE_KEY to build " +
      "without App Check."
    );
  }
  return null;
}

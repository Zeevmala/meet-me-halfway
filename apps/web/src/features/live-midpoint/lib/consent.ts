/**
 * What this tab has agreed to share its location with.
 *
 * Opening the link used to be the agreement. The page asked for location and
 * claimed a slot as it loaded, before saying what either was for, and so did
 * anything else that ran its JavaScript: a link scanner or a crawler took one
 * of four slots that are never released, and every visit to `/` — one that
 * refused location included — wrote a session record that is never deleted.
 * Now a tap on Start or Join comes first, and this remembers it.
 *
 * Per tab, because the page reloads itself — a deploy, a restore from the
 * back/forward cache, every Try again — and asking again each time would turn
 * a retry into two taps. Per session, because agreeing to share with one
 * group is not agreeing to share with the next: a different link in the same
 * tab asks again.
 */

const KEY = "mmh:consent";

/** Stands for "a session of my own", which has no code until it is created. */
const NEW_SESSION = "new";

/** Whether this tab agreed to join `code`, or with `null` to start a session. */
export function hasConsent(code: string | null): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === (code ?? NEW_SESSION);
  } catch {
    // No session storage: nothing was remembered, so ask.
    return false;
  }
}

/** Record the agreement to join `code`, or with `null` to start a session. */
export function rememberConsent(code: string | null): void {
  try {
    window.sessionStorage.setItem(KEY, code ?? NEW_SESSION);
  } catch {
    // Not remembered: the next load of this tab asks again, which is safe.
  }
}

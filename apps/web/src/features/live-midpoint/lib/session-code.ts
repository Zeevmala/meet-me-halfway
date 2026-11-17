/** Session code utilities. */

// Excludes ambiguous chars: 0/O, 1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * How long a new code is.
 *
 * The code is the session's only secret: anyone who has it can join while
 * there is room, and see where everyone is. And a code can be guessed, by
 * anyone signed in, because a live session has to be told from a dead one —
 * joining must succeed for one and fail for the other, and no rule can hide
 * that. At six characters there are 31^6 ≈ 887 million codes: at a thousand
 * probes a second, a handful of sessions running at once is found in hours.
 * Ten make it 31^10 ≈ 8 × 10^14, and the search hopeless.
 *
 * Moving to ten is a schema change, made expand/contract (CLAUDE.md): this
 * release's rules and `isValidCode` accept both lengths, while codes are
 * still drawn at six. The next release draws ten — set this to
 * `LONG_CODE_LENGTH` — once these rules are live, so no client ever creates a
 * session the deployed rules refuse. After 24 hours every live session has a
 * long code, and the release after that can stop accepting six.
 */
export const CODE_LENGTH = 6;

/** The length codes are moving to; accepted already, not yet drawn. */
export const LONG_CODE_LENGTH = 10;

const CODE_RE = new RegExp(
  `^(?:[${ALPHABET}]{6}|[${ALPHABET}]{${LONG_CODE_LENGTH}})$`,
);

/**
 * Bytes below this map onto the alphabet evenly; the rest are redrawn. A
 * plain `b % 31` over 0..255 gave the first 8 characters 9 chances in 256
 * against 8 for the others, shrinking the space a guesser has to search.
 */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** Generate a cryptographically random session code of `length`. */
export function generateCode(length: number = CODE_LENGTH): string {
  let code = "";
  const buf = new Uint8Array(length * 2);
  while (code.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < UNBIASED_LIMIT && code.length < length) {
        code += ALPHABET[b % ALPHABET.length];
      }
    }
  }
  return code;
}

/** Whether a string is a code the generator could have drawn, at either length. */
export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * The `?code=` of a query string, normalised but not validated; `null` when
 * there is none. Validation is the caller's: a mangled code has to fail as an
 * invalid link. Filtered out here it read as no code at all, and the page
 * created a new session in place of the one the link named — the joiner sat
 * alone, believing they had joined.
 */
export function codeFromQuery(search: string): string | null {
  const raw = new URLSearchParams(search).get("code");
  return raw ? normalizeCode(raw) : null;
}

/** Uppercase + trim for user-pasted codes. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

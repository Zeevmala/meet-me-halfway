/** 6-char alphanumeric session code utilities. */

// Excludes ambiguous chars: 0/O, 1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/**
 * Bytes below this map onto the alphabet evenly; the rest are redrawn. A
 * plain `b % 31` over 0..255 gave the first 8 characters 9 chances in 256
 * against 8 for the others, shrinking the space a guesser has to search.
 */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

/** Generate a cryptographically random 6-char session code. */
export function generateCode(): string {
  let code = "";
  const buf = new Uint8Array(CODE_LENGTH * 2);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < UNBIASED_LIMIT && code.length < CODE_LENGTH) {
        code += ALPHABET[b % ALPHABET.length];
      }
    }
  }
  return code;
}

/** Check whether a string is a valid session code. */
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

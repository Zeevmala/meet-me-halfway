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

/** Uppercase + trim for user-pasted codes. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

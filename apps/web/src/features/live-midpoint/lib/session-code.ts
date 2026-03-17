/** 6-char alphanumeric session code utilities. */

// Excludes ambiguous chars: 0/O, 1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

/** Generate a cryptographically random 6-char session code. */
export function generateCode(): string {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Check whether a string is a valid session code. */
export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** Uppercase + trim for user-pasted codes. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

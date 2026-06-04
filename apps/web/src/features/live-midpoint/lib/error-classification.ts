/**
 * Map a Firebase / network error to one of our typed session error codes.
 *
 * We split the catch-all "JOIN_FAILED" into two specific codes so the UI
 * can show actionable guidance and so we don't waste retry budget on
 * errors that will never recover (e.g. permission denied).
 */

export type JoinErrorKind =
  | "JOIN_PERMISSION_DENIED"
  | "JOIN_NETWORK_ERROR"
  | "JOIN_FAILED";

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

function readField(err: unknown, field: keyof ErrorLike): string {
  if (err && typeof err === "object" && field in err) {
    const v = (err as ErrorLike)[field];
    return typeof v === "string" ? v : "";
  }
  return "";
}

const PERMISSION_PATTERNS = [
  // Match all forms RTDB uses across transports: "PERMISSION_DENIED" (WS get),
  // "permission_denied at /path…" (listener cancel), and the bare
  // "Permission denied" (space-separated) that a denied get() rejects with.
  /permission[\s_-]?denied/i,
  /^auth\//, // firebase auth/* error codes
  /unauthorized/i,
  /unauthenticated/i,
  /app[-_ ]?check/i,
];

const NETWORK_PATTERNS = [
  /network[-_ ]?request[-_ ]?failed/i,
  /\bunavailable\b/i,
  /\bnetwork\b.*\berror\b/i,
  /\boffline\b/i,
  /failed to fetch/i,
  /\btimeout\b/i,
];

/**
 * Classify a thrown error into a join-error kind. Inspects `code`,
 * `message`, and `name` for known Firebase / fetch / WebSocket signals.
 */
export function classifyJoinError(err: unknown): JoinErrorKind {
  const code = readField(err, "code");
  const message = readField(err, "message");
  const name = readField(err, "name");
  const haystack = `${code} ${name} ${message}`;

  for (const re of PERMISSION_PATTERNS) {
    if (re.test(haystack)) return "JOIN_PERMISSION_DENIED";
  }
  for (const re of NETWORK_PATTERNS) {
    if (re.test(haystack)) return "JOIN_NETWORK_ERROR";
  }
  return "JOIN_FAILED";
}

/**
 * Extract a short, user-displayable description from an error.
 * Returns the firebase code if present, otherwise the message,
 * otherwise the constructor name, otherwise a generic string.
 */
export function describeError(err: unknown): string {
  const code = readField(err, "code");
  const message = readField(err, "message");
  if (code && message) return `${code}: ${message}`;
  if (code) return code;
  if (message) return message;
  const name = readField(err, "name");
  if (name) return name;
  return "Unknown error";
}

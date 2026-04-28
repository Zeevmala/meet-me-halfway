const STORAGE_KEY = "mmhw:displayName";
const MAX_LEN = 20;

function deriveFromUA(): string {
  if (typeof navigator === "undefined") return "Guest";
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Guest";
}

/**
 * Returns a display name for the current user, deriving and persisting one
 * if no value is already cached. Never prompts.
 */
export function getOrCreateDisplayName(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim()) return stored.slice(0, MAX_LEN);
  } catch {
    /* private mode / storage disabled */
  }
  const derived = deriveFromUA().slice(0, MAX_LEN);
  try {
    localStorage.setItem(STORAGE_KEY, derived);
  } catch {
    /* ignore */
  }
  return derived;
}

/** Validate and normalize an inbound name from the network. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().slice(0, MAX_LEN);
  return s.length > 0 ? s : null;
}

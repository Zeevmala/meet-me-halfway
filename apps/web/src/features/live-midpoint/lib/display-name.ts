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

/**
 * Persist a user-entered name. Returns the sanitized value actually stored
 * (falls back to UA-derived name if input was empty/invalid).
 */
export function saveDisplayName(raw: string): string {
  const cleaned = sanitizeName(raw);
  const value = cleaned ?? deriveFromUA().slice(0, MAX_LEN);
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode / storage disabled */
  }
  return value;
}

/** Returns the uppercase first character of a name, or null when empty. */
export function firstLetter(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  // Array.from handles surrogate pairs (e.g. emoji) cleanly.
  return Array.from(trimmed)[0]!.toUpperCase();
}

/**
 * True when `name` is an auto-derived device label (e.g. "Windows", "iPhone")
 * rather than a name the user explicitly chose. Used to decide whether to
 * show the name or a generic "You" for the current user.
 */
export function isDerivedName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.trim() === deriveFromUA();
}

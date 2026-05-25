/**
 * Detect common in-app browsers (WhatsApp, Instagram, Messenger, etc.).
 *
 * Why: in-app browsers — especially WhatsApp's Android WebView — often
 * use partitioned storage, block IndexedDB, or restrict WebSocket
 * transport, which silently breaks Firebase Auth / RTDB. When a session
 * join fails inside one of these, the most reliable user remedy is to
 * re-open the link in the OS default browser.
 */

export type InAppBrowser =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "messenger"
  | "twitter"
  | "tiktok"
  | "line"
  | "telegram"
  | null;

interface Rule {
  name: Exclude<InAppBrowser, null>;
  pattern: RegExp;
}

// Order matters: more specific tokens first (Messenger before Facebook).
const RULES: Rule[] = [
  { name: "whatsapp", pattern: /WhatsApp/i },
  { name: "instagram", pattern: /Instagram/i },
  { name: "messenger", pattern: /\b(Messenger|MessengerLite)\b/i },
  { name: "facebook", pattern: /\b(FB_IAB|FBAN|FBAV|FBIOS)\b/ },
  { name: "twitter", pattern: /\b(Twitter|TwitterAndroid)\b/i },
  { name: "tiktok", pattern: /\b(TikTok|musical_ly|BytedanceWebview)\b/i },
  { name: "line", pattern: /\bLine\// },
  { name: "telegram", pattern: /\bTelegram(Bot)?\b/i },
];

/**
 * Returns the in-app browser name if one is detected, else null.
 * Reads navigator.userAgent — safe to call in SSR-less browser contexts.
 */
export function detectInAppBrowser(
  ua: string = navigator.userAgent,
): InAppBrowser {
  for (const rule of RULES) {
    if (rule.pattern.test(ua)) return rule.name;
  }
  return null;
}

/**
 * Build a best-effort deep link that opens the given https URL in the
 * OS default browser, bypassing the current in-app browser.
 *
 * - iOS: x-safari-https:// scheme (Safari only; ignored by Chrome iOS).
 * - Android: intent:// with the URL's host+path, falling back to Chrome.
 * - Other / desktop: returns the original URL (caller should window.open).
 */
export function buildOpenInBrowserLink(url: string): string {
  const ua = navigator.userAgent;
  // iOS
  if (/iPhone|iPad|iPod/.test(ua)) {
    return url.replace(/^https:\/\//, "x-safari-https://");
  }
  // Android
  if (/Android/.test(ua)) {
    const parsed = new URL(url);
    const hostPath =
      parsed.host + parsed.pathname + parsed.search + parsed.hash;
    return `intent://${hostPath}#Intent;scheme=https;package=com.android.chrome;end`;
  }
  return url;
}

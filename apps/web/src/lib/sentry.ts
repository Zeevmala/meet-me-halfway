import * as Sentry from "@sentry/react";
import { APP_CONFIG } from "./config";

const dsn = APP_CONFIG.sentryDsn;

/** Sentry's own v10 deny list, carried over verbatim. */
const V10_DENY = ["forwarded", "-ip", "remote-", "via", "-user"];

/**
 * What a report may carry — pinned, never left to the SDK's default.
 *
 * public/privacy.html promises a report is "not enough to identify you". That
 * held in v10 because an unset `sendDefaultPii` was restrictive. v11 replaced
 * it with `dataCollection`, whose unset default is permissive: `userInfo:
 * true` alone switches Relay's IP inference from "never" to "auto", storing
 * every reporter's IP address. These are the v10 defaults Sentry documents for
 * keeping the old behaviour.
 */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: V10_DENY },
    response: { deny: V10_DENY },
  },
  httpBodies: [],
  urlQueryParams: { deny: V10_DENY },
} satisfies NonNullable<Sentry.BrowserOptions["dataCollection"]>;

/**
 * Locations and session codes, wherever the SDK picked them up.
 *
 * `dataCollection` gates categories of data, not what is inside them, and the
 * two things privacy.html says a report never carries sit where no category
 * reaches. Mapbox Directions puts every participant's coordinates in the URL
 * path — `urlQueryParams` filters queries only — and the SDK records that URL
 * in fetch breadcrumbs and request spans; a failed tile's URL names the area
 * on screen. The session code, which is what reads a session's locations, is
 * in the page URL every event carries and in Firebase's own console warnings
 * (`set at /sessions/{code}/…`). So everything bound for Sentry is scrubbed.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  // `/directions/v5/mapbox/{profile}/{lng},{lat};{lng},{lat}`
  [/(\/directions\/v5\/[^/]+\/[^/]+\/)[^?#\s"']+/g, "$1[redacted]"],
  // Map tiles: `/{z}/{x}/{y}` before the extension or query.
  [/\/\d{1,2}\/\d{1,8}\/\d{1,8}(?=[.@?#/]|$)/g, "/[redacted]"],
  // Any other coordinate pair, raw or URL-encoded.
  [/-?\d{1,3}\.\d+\s*(?:,|%2C)\s*-?\d{1,3}\.\d+/gi, "[redacted]"],
  [/([?&]code=)[^&#\s"']+/gi, "$1[redacted]"],
  [/(\bsessions\/)[^/?#\s"']+/g, "$1[redacted]"],
];

/** Generous: Sentry itself normalizes payloads to a depth of 3. */
const MAX_DEPTH = 12;

export function redact(text: string): string {
  return REDACTIONS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/** {@link redact} applied to every string in a payload, keeping its shape. */
export function scrub<T>(payload: T): T {
  return scrubValue(payload, 0) as T;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, depth + 1));
  }
  // Console breadcrumbs keep the logged arguments, errors among them; the
  // SDK would serialize one to these three fields anyway.
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      stack: value.stack === undefined ? undefined : redact(value.stack),
    };
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      scrubValue(item, depth + 1),
    ]),
  );
}

if (dsn !== null) {
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      replaysSessionSampleRate: 0,
      dataCollection: DATA_COLLECTION,
      // Errors, breadcrumbs and (streamed) spans are the three payloads the
      // browser SDK sends that can hold a URL or a logged message.
      beforeSend: (event) => scrub(event),
      beforeBreadcrumb: (breadcrumb) => scrub(breadcrumb),
      beforeSendSpan: (span) => scrub(span),
    });
  } catch {
    console.warn(
      "[Sentry] Failed to initialize — continuing without error tracking",
    );
  }
}

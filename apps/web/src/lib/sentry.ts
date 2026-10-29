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
    });
  } catch {
    console.warn(
      "[Sentry] Failed to initialize — continuing without error tracking",
    );
  }
}

import * as Sentry from "@sentry/react";
import { APP_CONFIG } from "./config";

const dsn = APP_CONFIG.sentryDsn;

if (dsn !== null) {
  try {
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      replaysSessionSampleRate: 0,
    });
  } catch {
    console.warn(
      "[Sentry] Failed to initialize — continuing without error tracking",
    );
  }
}

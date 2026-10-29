import { describe, it, expect, vi } from "vitest";
import type { BrowserOptions } from "@sentry/react";
import { createDirectionsClient } from "../features/live-midpoint/lib/directions-api";

// Held outside a vi.fn: init runs when ./sentry is first imported, before any
// test, and mock call records do not survive into the tests.
const captured = vi.hoisted(() => ({ options: null as BrowserOptions | null }));

vi.mock("@sentry/react", () => ({
  init: (options: BrowserOptions) => {
    captured.options = options;
  },
  browserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));

vi.mock("./config", () => ({
  APP_CONFIG: { sentryDsn: "https://key@o0.ingest.sentry.io/0" },
}));

import { redact, scrub } from "./sentry";

const TEL_AVIV = { lat: 32.0853, lng: 34.7818 };
const HAIFA = { lat: 32.794, lng: 34.9896 };
const COORDINATE_DIGITS = /32\.0853|34\.7818|32\.794|34\.9896/;

/** The URL the app's own Directions client requests, not a copy of it. */
async function directionsUrl(): Promise<string> {
  let requested = "";
  vi.stubGlobal("fetch", (url: string) => {
    requested = url;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  try {
    await createDirectionsClient("pk.test")(
      TEL_AVIV,
      HAIFA,
      "driving",
      new AbortController().signal,
    );
  } finally {
    vi.unstubAllGlobals();
  }
  return requested;
}

describe("Sentry init", () => {
  // Left unset, v11's `dataCollection` stores every reporter's IP address,
  // which privacy.html says a report never carries. Nothing else would notice.
  it("never lets the SDK identify the reporter", () => {
    expect(captured.options?.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
    });
  });

  it("scrubs errors, breadcrumbs and spans before they leave", async () => {
    const url = await directionsUrl();
    const options = captured.options;
    expect(COORDINATE_DIGITS.test(url)).toBe(true);

    const breadcrumb = options?.beforeBreadcrumb?.({
      category: "fetch",
      data: { method: "GET", url },
    });
    const event = await options?.beforeSend?.(
      { type: undefined, request: { url: "https://x.web.app/?code=ABC234" } },
      {},
    );
    const span = options?.beforeSendSpan?.({
      name: `GET ${url}`,
      span_id: "1",
      trace_id: "1",
      start_timestamp: 0,
      end_timestamp: 1,
      status: "ok",
      is_segment: false,
      attributes: { "url.full": { type: "string", value: url } },
    });

    expect(breadcrumb?.data?.url).toContain("/driving/[redacted]?");
    expect(span?.name).toContain("/driving/[redacted]?");
    expect(JSON.stringify([breadcrumb, span])).not.toMatch(COORDINATE_DIGITS);
    expect(event?.request?.url).toBe("https://x.web.app/?code=[redacted]");
  });
});

describe("redact", () => {
  it("removes every participant's position from a Directions request", async () => {
    const redacted = redact(await directionsUrl());

    expect(redacted).not.toMatch(COORDINATE_DIGITS);
    expect(redacted).toContain(
      "https://api.mapbox.com/directions/v5/mapbox/driving/[redacted]?",
    );
  });

  it.each([
    ["a coordinate pair", "at 32.0853, 34.7818", "at [redacted]"],
    ["an encoded pair", "ll=32.0853%2C34.7818&z=3", "ll=[redacted]&z=3"],
    [
      "a map tile",
      "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/14/9724/6620.vector.pbf",
      "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/[redacted].vector.pbf",
    ],
    [
      "the session code in the page URL",
      "https://meet-me-halfway-4ae79.web.app/?code=ABC234",
      "https://meet-me-halfway-4ae79.web.app/?code=[redacted]",
    ],
    [
      "the session code in a database path",
      "FIREBASE WARNING: set at /sessions/ABC234/participants/1 failed: permission_denied",
      "FIREBASE WARNING: set at /sessions/[redacted]/participants/1 failed: permission_denied",
    ],
  ])("removes %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("leaves everything else alone", () => {
    const text = "[directions-api] HTTP 429: Too Many Requests (retry in 2.5s)";
    expect(redact(text)).toBe(text);
  });
});

describe("scrub", () => {
  it("redacts strings at any depth and keeps the payload's shape", () => {
    const payload = {
      level: "error",
      count: 3,
      nested: [{ url: "/?code=ABC234", ok: true }],
      error: new TypeError("set at /sessions/ABC234/slots/1 failed"),
    };

    expect(scrub(payload)).toEqual({
      level: "error",
      count: 3,
      nested: [{ url: "/?code=[redacted]", ok: true }],
      error: expect.objectContaining({
        name: "TypeError",
        message: "set at /sessions/[redacted]/slots/1 failed",
      }),
    });
  });
});

import { describe, it, expect, vi } from "vitest";

const mockInit = vi.fn();
vi.mock("@sentry/react", () => ({
  init: (options: unknown) => mockInit(options),
  browserTracingIntegration: () => ({ name: "BrowserTracing" }),
}));

vi.mock("./config", () => ({
  APP_CONFIG: { sentryDsn: "https://key@o0.ingest.sentry.io/0" },
}));

describe("Sentry init", () => {
  // Left unset, v11's `dataCollection` stores every reporter's IP address,
  // which privacy.html says a report never carries. Nothing else would notice.
  it("never lets the SDK identify the reporter", async () => {
    await import("./sentry");

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0]?.[0]).toMatchObject({
      dataCollection: { userInfo: false, cookies: false, httpBodies: [] },
    });
  });
});

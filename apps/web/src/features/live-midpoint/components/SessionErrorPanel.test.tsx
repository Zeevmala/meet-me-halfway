import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import SessionErrorPanel from "./SessionErrorPanel";

// Stub react-i18next: return the key as-is for assertion stability.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const originalUA = navigator.userAgent;
const setUA = (ua: string) =>
  Object.defineProperty(navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
const restoreUA = () =>
  Object.defineProperty(navigator, "userAgent", {
    value: originalUA,
    configurable: true,
  });

describe("SessionErrorPanel", () => {
  beforeEach(() => {
    // Default to a regular Chrome UA so the in-app callout is hidden.
    setUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
  });
  afterEach(() => {
    restoreUA();
  });

  it("renders the i18n key for the error code as the title", () => {
    render(<SessionErrorPanel errorCode="JOIN_FAILED" errorDetails={null} />);
    expect(screen.getByText("live.sessionJoinFailed")).toBeTruthy();
  });

  it("shows the retry button for retryable error codes", () => {
    render(
      <SessionErrorPanel
        errorCode="JOIN_PERMISSION_DENIED"
        errorDetails={null}
      />,
    );
    expect(screen.getByRole("button", { name: "common.retry" })).toBeTruthy();
  });

  it("hides the retry button for non-retryable error codes", () => {
    render(
      <SessionErrorPanel errorCode="SESSION_NOT_FOUND" errorDetails={null} />,
    );
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("renders Details expander when errorDetails is provided", () => {
    render(
      <SessionErrorPanel
        errorCode="JOIN_FAILED"
        errorDetails="PERMISSION_DENIED: some reason"
      />,
    );
    expect(screen.getByText("live.errorDetails")).toBeTruthy();
    expect(screen.getByText("PERMISSION_DENIED: some reason")).toBeTruthy();
  });

  it("hides Details expander when errorDetails is null", () => {
    render(<SessionErrorPanel errorCode="JOIN_FAILED" errorDetails={null} />);
    expect(screen.queryByText("live.errorDetails")).toBeNull();
  });

  it("hides the in-app browser callout in a regular browser", () => {
    render(<SessionErrorPanel errorCode="JOIN_FAILED" errorDetails={null} />);
    expect(screen.queryByText("live.inAppBrowserDetected")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "live.openInBrowser" }),
    ).toBeNull();
  });

  it("shows the in-app browser callout in a WhatsApp UA", () => {
    setUA(
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.5.78 A",
    );
    render(<SessionErrorPanel errorCode="JOIN_FAILED" errorDetails={null} />);
    expect(screen.getByText("live.inAppBrowserDetected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "live.openInBrowser" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "live.copyLink" })).toBeTruthy();
  });

  it("does not show the in-app callout for non-join error codes even in WhatsApp", () => {
    setUA(
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.5.78 A",
    );
    render(<SessionErrorPanel errorCode="SESSION_FULL" errorDetails={null} />);
    expect(screen.queryByText("live.inAppBrowserDetected")).toBeNull();
  });
});

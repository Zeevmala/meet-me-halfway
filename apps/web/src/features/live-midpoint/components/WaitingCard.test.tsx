import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock i18next — returns the key (with opts JSON appended)
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

vi.mock("../styles/live-midpoint.css", () => ({}));

import WaitingCard from "./WaitingCard";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("WaitingCard", () => {
  const CODE = "ABC123";

  it("renders waiting title", () => {
    render(<WaitingCard code={CODE} />);
    expect(screen.getByText("live.waitingTitle")).toBeTruthy();
  });

  it("WhatsApp link contains correct URL with code", () => {
    render(<WaitingCard code={CODE} />);
    const link = screen.getByText("live.shareWhatsApp").closest("a")!;
    const shareUrl = `${window.location.origin}?code=${CODE}`;
    expect(link.getAttribute("href")).toContain(encodeURIComponent(shareUrl));
  });

  it("WhatsApp link opens in new tab", () => {
    render(<WaitingCard code={CODE} />);
    const link = screen.getByText("live.shareWhatsApp").closest("a")!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it('copy button shows "live.copyLink" initially', () => {
    render(<WaitingCard code={CODE} />);
    expect(screen.getByRole("button", { name: "live.copyLink" })).toBeTruthy();
  });

  it('copy button calls clipboard API and shows "live.linkCopied" after click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<WaitingCard code={CODE} />);
    const btn = screen.getByRole("button", { name: "live.copyLink" });

    await act(async () => {
      fireEvent.click(btn);
    });

    const shareUrl = `${window.location.origin}?code=${CODE}`;
    expect(writeText).toHaveBeenCalledWith(shareUrl);
    expect(
      screen.getByRole("button", { name: "live.linkCopied" }),
    ).toBeTruthy();
  });

  it("falls back to window.prompt when clipboard fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => null);

    render(<WaitingCard code={CODE} />);
    const btn = screen.getByRole("button", { name: "live.copyLink" });

    await act(async () => {
      fireEvent.click(btn);
    });

    const shareUrl = `${window.location.origin}?code=${CODE}`;
    expect(promptSpy).toHaveBeenCalledWith("live.copyLink", shareUrl);
  });
});

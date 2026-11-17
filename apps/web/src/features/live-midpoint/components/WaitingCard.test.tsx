import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock the string table — returns the key (with opts JSON appended)
vi.mock("../../../strings", () => ({
  t: (key: string, opts?: Record<string, unknown>) => {
    if (opts) return `${key}:${JSON.stringify(opts)}`;
    return key;
  },
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

  // Followed in place, they unloaded the page — tearing down the session
  // listener and GPS — and Back restored it frozen.
  it("opens the legal pages in a new tab, keeping the session", () => {
    render(<WaitingCard code="ABC234" />);

    for (const name of ["live.privacy", "live.terms"]) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });
});

describe("WaitingCard — full session", () => {
  const CODE = "ABC234";

  // Every slot is claimed: an invite could only be refused.
  it("offers no invite", () => {
    render(<WaitingCard code={CODE} full />);

    expect(screen.getByText("live.waitingReturnTitle")).toBeTruthy();
    expect(screen.getByText("live.sessionFullWaiting")).toBeTruthy();
    expect(screen.queryByText("live.waitingTitle")).toBeNull();
    expect(screen.queryByText("live.shareWhatsApp")).toBeNull();
    expect(screen.queryByRole("button", { name: "live.copyLink" })).toBeNull();
  });

  it("offers a new session of one's own instead", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    try {
      render(<WaitingCard code={CODE} full />);

      fireEvent.click(
        screen.getByRole("button", { name: "live.startNewSession" }),
      );

      expect(assign).toHaveBeenCalledWith("/");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the legal links", () => {
    render(<WaitingCard code={CODE} full />);

    expect(screen.getByRole("link", { name: "live.privacy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "live.terms" })).toBeTruthy();
  });
});

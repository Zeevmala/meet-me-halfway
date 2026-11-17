import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useShareLink } from "./useShareLink";

// The real strings, on purpose: what reaches the share sheet is the copy.

const CODE = "K7M2QX";
const LINK = `${window.location.origin}?code=${CODE}`;

function stubShare(share: (data: ShareData) => Promise<void>) {
  Object.defineProperty(navigator, "share", {
    value: share,
    configurable: true,
  });
  Object.defineProperty(navigator, "canShare", {
    value: () => true,
    configurable: true,
  });
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  stubClipboard(vi.fn().mockResolvedValue(undefined));
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "canShare");
  vi.restoreAllMocks();
});

describe("useShareLink — the share sheet", () => {
  // The regression: the link was in `text` and in `url`, and a share target
  // that joins the two sent the invite with the link in it twice.
  it("hands the link over once, as the url, and never inside the text", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubShare(share);
    const { result } = renderHook(() => useShareLink(CODE));

    await act(() => result.current.share());

    expect(share).toHaveBeenCalledTimes(1);
    const data = share.mock.calls[0][0] as ShareData;
    expect(data.url).toBe(LINK);
    expect(data.text).toBe("Let's meet halfway! Join our group:");
    expect(data.text).not.toContain("http");
    expect(data.title).toBe("Meet Me Halfway");
  });

  it("copies the link where the browser has no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useShareLink(CODE));

    await act(() => result.current.share());

    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(result.current.copied).toBe(true);
  });

  it("takes a closed share sheet as an answer, and copies nothing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    stubShare(() =>
      Promise.reject(new DOMException("Share canceled", "AbortError")),
    );
    const { result } = renderHook(() => useShareLink(CODE));

    await act(() => result.current.share());

    expect(writeText).not.toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
  });

  it("falls back to copying when the share sheet fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    stubShare(() => Promise.reject(new Error("NotAllowedError")));
    const { result } = renderHook(() => useShareLink(CODE));

    await act(() => result.current.share());

    expect(writeText).toHaveBeenCalledWith(LINK);
  });
});

describe("useShareLink — WhatsApp", () => {
  // One string is all wa.me takes, so the sentence and the link share it.
  it("sends the invitation followed by the link, once", () => {
    const { result } = renderHook(() => useShareLink(CODE));

    const text = new URL(result.current.whatsappUrl).searchParams.get("text");

    expect(text).toBe(`Let's meet halfway! Join our group: ${LINK}`);
    expect(text?.split(LINK)).toHaveLength(2);
  });
});

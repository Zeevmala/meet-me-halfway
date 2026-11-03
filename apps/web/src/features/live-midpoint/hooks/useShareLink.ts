import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/** How long "Link copied" stays up. */
const COPIED_MS = 2000;

export interface ShareLink {
  readonly shareUrl: string;
  readonly whatsappUrl: string;
  /** The link was just copied — for the moment of feedback after a copy. */
  readonly copied: boolean;
  /** Copy the link, or offer it in a prompt where the clipboard is refused. */
  readonly copy: () => Promise<void>;
  /** The system share sheet where the browser can open one, else `copy`. */
  readonly share: () => Promise<void>;
}

/**
 * The session's invite link and the ways to send it.
 *
 * WaitingCard and the midpoint card each carried their own copy of this — the
 * same clipboard fallback, the same prompt, the same `setTimeout` left running
 * past unmount. The session chip in the top bar now shares too, so it lives
 * here once.
 */
export function useShareLink(code: string): ShareLink {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const shareUrl = `${window.location.origin}?code=${code}`;
  const message = t("live.shareMessage", { url: shareUrl });
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // No clipboard (an old browser, or one refusing it): hand it over.
      window.prompt(t("live.copyLink"), shareUrl);
    }
  }, [shareUrl, t]);

  const share = useCallback(async () => {
    // navigator.share exists on desktop Chrome but works only on mobile, over
    // HTTPS, with transient user activation; canShare() is the real test.
    const canNativeShare =
      typeof navigator.share === "function" &&
      typeof navigator.canShare === "function" &&
      navigator.canShare({ url: shareUrl });
    if (!canNativeShare) {
      await copy();
      return;
    }
    try {
      await navigator.share({
        title: t("app.title"),
        text: message,
        url: shareUrl,
      });
    } catch (err: unknown) {
      // AbortError: the user closed the sheet, which is an answer, not a fault.
      if (err instanceof DOMException && err.name === "AbortError") return;
      await copy();
    }
  }, [copy, message, shareUrl, t]);

  return { shareUrl, whatsappUrl, copied, copy, share };
}

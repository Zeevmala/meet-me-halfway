import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/live-midpoint.css";

interface WaitingCardProps {
  code: string;
}

/** Bottom card shown while waiting for partner to join. */
export default function WaitingCard({ code }: WaitingCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const shareUrl = `${window.location.origin}?code=${code}`;

  const handleWhatsApp = useCallback(() => {
    const text = encodeURIComponent(t("live.shareMessage", { url: shareUrl }));
    window.open(`https://wa.me/?text=${text}`, "_blank");
  }, [shareUrl, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      window.prompt(t("live.copyLink"), shareUrl);
    }
  }, [shareUrl, t]);

  return (
    <>
      <div className="live-card live-glass live-waiting-shimmer">
        <div className="live-waiting-title">{t("live.waitingTitle")}</div>
        <div className="live-waiting-subtitle">{t("live.waitingSubtitle")}</div>
        <div className="live-waiting-actions">
          <button
            type="button"
            className="live-btn live-btn--whatsapp"
            onClick={handleWhatsApp}
          >
            {t("live.shareWhatsApp")}
          </button>
          <button
            type="button"
            className="live-btn live-btn--copy"
            onClick={handleCopy}
          >
            {copied ? t("live.linkCopied") : t("live.copyLink")}
          </button>
        </div>
      </div>
    </>
  );
}

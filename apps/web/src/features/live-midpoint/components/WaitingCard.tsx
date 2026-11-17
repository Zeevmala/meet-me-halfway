import { memo } from "react";
import { t } from "../../../strings";
import { useShareLink } from "../hooks/useShareLink";
import "../styles/live-midpoint.css";

interface WaitingCardProps {
  code: string;
  /**
   * All five slots are claimed. The others can still come back to theirs,
   * but nobody new can join, so the card offers no invite — sent, it led
   * straight to "Session is full".
   */
  full?: boolean;
}

/** Bottom card shown while nobody else is here. */
export default memo(function WaitingCard({
  code,
  full = false,
}: WaitingCardProps) {
  const { whatsappUrl, copied, copy } = useShareLink(code);

  return (
    <div className="live-card live-glass live-waiting-shimmer">
      {full ? (
        <>
          <div className="live-waiting-title">
            {t("live.waitingReturnTitle")}
          </div>
          <div className="live-waiting-subtitle">
            {t("live.sessionFullWaiting")}
          </div>
          <div className="live-waiting-actions">
            <button
              type="button"
              className="live-btn live-btn-secondary"
              onClick={() => window.location.assign("/")}
            >
              {t("live.startNewSession")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="live-waiting-title">{t("live.waitingTitle")}</div>
          <div className="live-waiting-actions">
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="live-btn live-btn--whatsapp"
            >
              {t("live.shareWhatsApp")}
            </a>
            <button
              type="button"
              className="live-btn live-btn--copy"
              onClick={() => void copy()}
            >
              {copied ? t("live.linkCopied") : t("live.copyLink")}
            </button>
          </div>
        </>
      )}
    </div>
  );
});

import { memo } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { whatsappUrl, copied, copy } = useShareLink(code);

  return (
    <>
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
      {/* A new tab, so reading them does not leave the session. Followed in
          place, they unloaded the page, and Back restored it frozen. */}
      <nav className="live-legal-links" aria-label="Legal">
        <a href="/privacy" target="_blank" rel="noopener noreferrer">
          {t("live.privacy")}
        </a>
        <span aria-hidden="true">&middot;</span>
        <a href="/terms" target="_blank" rel="noopener noreferrer">
          {t("live.terms")}
        </a>
        <span aria-hidden="true">&middot;</span>
        <a
          href="https://github.com/zeevmala/meet-me-halfway"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("live.github")}
        </a>
      </nav>
    </>
  );
});

import { memo } from "react";
import { t } from "../../../strings";
import "../styles/live-midpoint.css";

/**
 * Privacy, Terms and the source, wherever the page is.
 *
 * They used to be part of the waiting card, which only a creator sees: a
 * joiner goes from "Connecting" straight to the meeting card, so the person
 * who did not choose this app was never shown its privacy policy at all.
 *
 * A new tab, so reading them does not leave the session. Followed in place,
 * they unloaded the page, and Back restored it frozen.
 */
export default memo(function LegalLinks() {
  return (
    <nav className="live-legal-links" aria-label={t("live.legalLabel")}>
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
  );
});

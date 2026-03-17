import { useTranslation } from "react-i18next";
import type { SessionPhase } from "../hooks/useLiveSession";
import "../styles/live-midpoint.css";

interface SessionBadgeProps {
  code: string;
  phase: SessionPhase;
  ownConnected: boolean;
  partnerConnected: boolean;
}

/** Top bar overlay: session code, live dot, participant status pills. */
export default function SessionBadge({
  code,
  phase,
  ownConnected,
  partnerConnected,
}: SessionBadgeProps) {
  const { t } = useTranslation();

  return (
    <div className="live-badge live-glass">
      <span className="live-badge-code">{code}</span>
      {(phase === "connected" || phase === "partner_stale") && (
        <span className="live-badge-dot" aria-label={t("live.liveIndicator")} />
      )}
      <div className="live-badge-pills">
        <div className="live-pill">
          <span
            className={`live-pill-dot ${ownConnected ? "live-pill-dot--green" : "live-pill-dot--gray"}`}
          />
          {t("live.you")}
        </div>
        <div className="live-pill">
          <span
            className={`live-pill-dot ${partnerConnected ? "live-pill-dot--blue" : "live-pill-dot--gray"}`}
          />
          {t("live.partner")}
        </div>
      </div>
    </div>
  );
}

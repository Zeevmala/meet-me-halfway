import { useTranslation } from "react-i18next";
import type { SessionPhase } from "../hooks/useLiveSession";
import type { ParticipantIndex } from "../lib/participant-config";
import "../styles/live-midpoint.css";

interface SessionBadgeProps {
  code: string;
  phase: SessionPhase;
  ownConnected: boolean;
  ownIndex: ParticipantIndex;
  participants: Array<{ index: ParticipantIndex; connected: boolean }>;
}

/** Top bar overlay: session code, live dot, participant status pills. */
export default function SessionBadge({
  code,
  phase,
  ownConnected,
  ownIndex,
  participants,
}: SessionBadgeProps) {
  const { t } = useTranslation();

  return (
    <header className="live-badge live-glass">
      <span className="live-badge-code">{code}</span>
      {(phase === "connected" || phase === "some_stale") && (
        <span className="live-badge-dot" aria-label={t("live.liveIndicator")} />
      )}
      <div className="live-badge-pills">
        <div className="live-pill">
          <span
            className={`live-pill-dot ${ownConnected ? `live-pill-dot--p${ownIndex}` : "live-pill-dot--gray"}`}
          />
          {t("live.you")}
        </div>
        {participants.map((p) => (
          <div key={p.index} className="live-pill">
            <span
              className={`live-pill-dot ${p.connected ? `live-pill-dot--p${p.index}` : "live-pill-dot--gray"}`}
            />
            {t("live.participant", { n: p.index + 1 })}
          </div>
        ))}
      </div>
    </header>
  );
}

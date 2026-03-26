import { useTranslation } from "react-i18next";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import { wazeLink, googleMapsLink } from "../lib/nav-links";
import type { RouteInfo, TravelProfile } from "../hooks/useDirections";
import type { ParticipantIndex } from "../lib/participant-config";
import "../styles/live-midpoint.css";

interface OtherParticipant {
  index: ParticipantIndex;
  route: RouteInfo | null;
  position: LatLng;
  stale: boolean;
}

interface MidpointCardProps {
  midpoint: LatLng;
  ownIndex: ParticipantIndex;
  ownPosition: LatLng;
  ownRoute: RouteInfo | null;
  otherParticipants: OtherParticipant[];
  destination: LatLng;
  travelProfile: TravelProfile;
  onProfileChange: (profile: TravelProfile) => void;
  selectedVenueName: string | null;
}

function formatDuration(seconds: number): string {
  return String(Math.ceil(seconds / 60));
}

/** Bottom card shown when participants are connected. */
export default function MidpointCard({
  midpoint,
  ownIndex,
  ownPosition,
  ownRoute,
  otherParticipants,
  destination,
  travelProfile,
  onProfileChange,
  selectedVenueName,
}: MidpointCardProps) {
  const { t } = useTranslation();

  const timeKey =
    travelProfile === "walking" ? "live.walkTime" : "live.driveTime";

  const staleParticipants = otherParticipants.filter((p) => p.stale);

  return (
    <div className="live-card live-glass">
      {staleParticipants.length > 0 && (
        <div className="live-stale-warning">
          <span>&#9888;</span>
          <div>
            {staleParticipants.map((p) => (
              <div key={p.index}>
                {t("live.participantStale", { n: p.index + 1 })}
              </div>
            ))}
            <div className="live-stale-hint">
              {t("live.participantStaleHint")}
            </div>
          </div>
        </div>
      )}

      {selectedVenueName && (
        <div className="live-destination-name">
          {t("live.meetAt", { name: selectedVenueName })}
        </div>
      )}

      <div className="live-profile-toggle">
        <button
          type="button"
          aria-pressed={travelProfile === "driving"}
          className={`live-profile-btn${travelProfile === "driving" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("driving")}
        >
          {t("live.driving")}
        </button>
        <button
          type="button"
          aria-pressed={travelProfile === "walking"}
          className={`live-profile-btn${travelProfile === "walking" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("walking")}
        >
          {t("live.walking")}
        </button>
      </div>

      {/* Your distance — full width */}
      <div className="live-stats live-stats--own">
        <div className="live-stat">
          <div className="live-stat-label">{t("live.yourDistance")}</div>
          <div className={`live-stat-value live-stat-value--p${ownIndex}`}>
            {ownRoute
              ? formatDistance(ownRoute.distance)
              : formatDistance(haversineDistance(ownPosition, midpoint))}
          </div>
          {ownRoute && (
            <div className="live-stat-sub">
              {t(timeKey, { minutes: formatDuration(ownRoute.duration) })}
            </div>
          )}
        </div>
      </div>

      {/* Other participants' distances */}
      {otherParticipants.length > 0 && (
        <div className="live-participant-list">
          <div className="live-stats">
            {otherParticipants.map((p) => (
              <div key={p.index} className="live-stat">
                <div className="live-stat-label">
                  <span
                    className={`live-stat-dot live-stat-dot--p${p.index}`}
                  />
                  {t("live.participantDistance", { n: p.index + 1 })}
                </div>
                <div className={`live-stat-value live-stat-value--p${p.index}`}>
                  {p.route
                    ? formatDistance(p.route.distance)
                    : formatDistance(haversineDistance(p.position, midpoint))}
                </div>
                {p.route && (
                  <div className="live-stat-sub">
                    {t(timeKey, {
                      minutes: formatDuration(p.route.duration),
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="live-nav-buttons">
        <a
          href={wazeLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
        >
          {t("live.navigateWaze")}
        </a>
        <a
          href={googleMapsLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
        >
          {t("live.navigateGoogle")}
        </a>
      </div>
    </div>
  );
}

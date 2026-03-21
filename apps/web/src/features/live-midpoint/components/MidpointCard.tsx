import { useTranslation } from "react-i18next";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import { wazeLink, googleMapsLink } from "../lib/nav-links";
import type { RouteInfo, TravelProfile } from "../hooks/useDirections";
import "../styles/live-midpoint.css";

interface MidpointCardProps {
  midpoint: LatLng;
  posA: LatLng;
  posB: LatLng;
  routeA: RouteInfo | null;
  routeB: RouteInfo | null;
  partnerStale: boolean;
  destination: LatLng;
  travelProfile: TravelProfile;
  onProfileChange: (profile: TravelProfile) => void;
  selectedVenueName: string | null;
}

function formatDuration(seconds: number): string {
  return String(Math.ceil(seconds / 60));
}

/** Bottom card shown when both participants are connected. */
export default function MidpointCard({
  midpoint,
  posA,
  posB,
  routeA,
  routeB,
  partnerStale,
  destination,
  travelProfile,
  onProfileChange,
  selectedVenueName,
}: MidpointCardProps) {
  const { t } = useTranslation();

  const totalDistance = haversineDistance(posA, posB);
  const timeKey =
    travelProfile === "walking" ? "live.walkTime" : "live.driveTime";

  return (
    <div className="live-card live-glass">
      {partnerStale && (
        <div className="live-stale-warning">
          <span>&#9888;</span>
          {t("live.partnerStale")}
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
          className={`live-profile-btn${travelProfile === "driving" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("driving")}
        >
          {t("live.driving")}
        </button>
        <button
          type="button"
          className={`live-profile-btn${travelProfile === "walking" ? " live-profile-btn--active" : ""}`}
          onClick={() => onProfileChange("walking")}
        >
          {t("live.walking")}
        </button>
      </div>

      <div className="live-stats">
        <div className="live-stat">
          <div className="live-stat-label">{t("live.yourDistance")}</div>
          <div className="live-stat-value live-stat-value--green">
            {routeA
              ? formatDistance(routeA.distance)
              : formatDistance(haversineDistance(posA, midpoint))}
          </div>
          {routeA && (
            <div className="live-stat-sub">
              {t(timeKey, { minutes: formatDuration(routeA.duration) })}
            </div>
          )}
        </div>

        <div className="live-stat">
          <div className="live-stat-label">{t("live.partnerDistance")}</div>
          <div className="live-stat-value live-stat-value--blue">
            {routeB
              ? formatDistance(routeB.distance)
              : formatDistance(haversineDistance(posB, midpoint))}
          </div>
          {routeB && (
            <div className="live-stat-sub">
              {t(timeKey, { minutes: formatDuration(routeB.duration) })}
            </div>
          )}
        </div>

        <div className="live-stat live-stat--full">
          <div className="live-stat-label">{t("live.totalDistance")}</div>
          <div className="live-stat-value">{formatDistance(totalDistance)}</div>
        </div>
      </div>

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

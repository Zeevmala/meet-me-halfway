import { useTranslation } from "react-i18next";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import { wazeLink, googleMapsLink } from "../lib/nav-links";
import type { RouteInfo } from "../hooks/useDirections";
import "../styles/live-midpoint.css";

interface MidpointCardProps {
  midpoint: LatLng;
  posA: LatLng;
  posB: LatLng;
  routeA: RouteInfo | null;
  routeB: RouteInfo | null;
  partnerStale: boolean;
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
}: MidpointCardProps) {
  const { t } = useTranslation();

  const totalDistance = haversineDistance(posA, posB);

  return (
    <div className="live-card live-glass">
      {partnerStale && (
        <div className="live-stale-warning">
          <span>&#9888;</span>
          {t("live.partnerStale")}
        </div>
      )}

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
              {t("live.driveTime", {
                minutes: formatDuration(routeA.duration),
              })}
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
              {t("live.driveTime", {
                minutes: formatDuration(routeB.duration),
              })}
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
          href={wazeLink(midpoint.lat, midpoint.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
        >
          {t("live.navigateWaze")}
        </a>
        <a
          href={googleMapsLink(midpoint.lat, midpoint.lng)}
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

import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { LatLng } from "../lib/geo-math";
import { haversineDistance, formatDistance } from "../lib/geo-math";
import { wazeLink, googleMapsLink } from "../lib/nav-links";
import { etaParts, etaSpreadMinutes } from "../lib/eta";
import type { RouteInfo, TravelProfile } from "../graph/types";
import type { ParticipantIndex } from "../lib/participant-config";
import { NavigateGlyph } from "./icons";
import "../styles/live-midpoint.css";

interface OtherParticipant {
  index: ParticipantIndex;
  route: RouteInfo | null;
  position: LatLng;
  stale: boolean;
  name: string | null;
}

interface MidpointCardProps {
  ownIndex: ParticipantIndex;
  ownPosition: LatLng;
  ownRoute: RouteInfo | null;
  otherParticipants: readonly OtherParticipant[];
  /**
   * Where everyone is going: the picked venue, else the midpoint. The
   * straight-line fallback measures to this too — it used to measure to the
   * midpoint, so with a venue picked and no route yet, "Meet at X" listed
   * distances to somewhere else.
   */
  destination: LatLng;
  travelProfile: TravelProfile;
  onProfileChange: (profile: TravelProfile) => void;
  selectedVenueName: string | null;
  /** The last routes are being served after a failed refresh. */
  routesStale: boolean;
}

interface Row {
  readonly index: ParticipantIndex;
  readonly name: string;
  readonly own: boolean;
  readonly stale: boolean;
  readonly route: RouteInfo | null;
  readonly position: LatLng;
}

/**
 * The trip, compact: where, how, everyone's arrival time, and the way to go.
 *
 * It used to be a stack of equal boxes — a mode toggle on its own row, a
 * two-column grid of distance cards, two long navigation buttons, and a
 * full-width Share as the loudest thing on screen once everyone had arrived.
 * Inviting moved to the session code in the top bar; what is left leads with
 * time, because whether to leave now depends on how long the trip takes, and
 * with Navigate, because going is the next step.
 */
export default memo(function MidpointCard({
  ownIndex,
  ownPosition,
  ownRoute,
  otherParticipants,
  destination,
  travelProfile,
  onProfileChange,
  selectedVenueName,
  routesStale,
}: MidpointCardProps) {
  const { t } = useTranslation();

  const rows: Row[] = [
    {
      index: ownIndex,
      name: t("live.you"),
      own: true,
      stale: false,
      route: ownRoute,
      position: ownPosition,
    },
    ...otherParticipants.map((p) => ({
      index: p.index,
      name: p.name ?? t("live.participant", { n: p.index + 1 }),
      own: false,
      stale: p.stale,
      route: p.route,
      position: p.position,
    })),
  ];

  const spread = etaSpreadMinutes(rows.map((row) => row.route));
  const anyStale = rows.some((row) => row.stale);

  const eta = (seconds: number) => {
    const { hours, minutes } = etaParts(seconds);
    if (hours === 0) return t("live.etaMinutes", { minutes });
    if (minutes === 0) return t("live.etaHoursExact", { hours });
    return t("live.etaHours", { hours, minutes });
  };

  return (
    <div className="live-card live-glass live-trip">
      <div className="live-trip-head">
        <div className="live-trip-title">
          <span className="live-trip-dest">
            {selectedVenueName
              ? t("live.meetAt", { name: selectedVenueName })
              : t("live.midpoint")}
          </span>
          {spread !== null && (
            <span className="live-trip-spread">
              {spread <= 1
                ? t("live.spreadEven")
                : t("live.spread", { minutes: spread })}
            </span>
          )}
        </div>
        <div
          className="live-profile-toggle"
          role="group"
          aria-label={t("live.travelMode")}
        >
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
      </div>

      <ul className="live-eta-list">
        {rows.map((row) => (
          <li
            key={row.index}
            className={`live-eta-row${row.own ? " live-eta-row--own" : ""}${row.stale ? " live-eta-row--stale" : ""}`}
          >
            <span
              className={`live-eta-dot live-eta-dot--p${row.index}`}
              aria-hidden="true"
            />
            <span className="live-eta-name">{row.name}</span>
            {row.stale && (
              <span className="live-eta-tag">{t("live.staleTag")}</span>
            )}
            <span className={`live-eta-time live-eta-time--p${row.index}`}>
              {row.route ? eta(row.route.duration) : "—"}
            </span>
            {/* bdi: "40.6 km" is a left-to-right run, and inside a Hebrew
                row the bidi algorithm laid it out as "km 40.6". */}
            <span className="live-eta-dist">
              <bdi>
                {formatDistance(
                  row.route
                    ? row.route.distance
                    : haversineDistance(row.position, destination),
                )}
              </bdi>
            </span>
          </li>
        ))}
      </ul>

      {anyStale && (
        <div className="live-eta-hint">{t("live.participantStaleHint")}</div>
      )}

      {routesStale && (
        <div className="live-routes-stale" role="status">
          {t("live.routesStale")}
        </div>
      )}

      <div className="live-nav-buttons">
        <a
          href={wazeLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
          aria-label={t("live.navigateWaze")}
        >
          <NavigateGlyph />
          {t("live.waze")}
        </a>
        <a
          href={googleMapsLink(destination.lat, destination.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="live-btn live-btn--nav"
          aria-label={t("live.navigateGoogle")}
        >
          <NavigateGlyph />
          {t("live.googleMaps")}
        </a>
      </div>
    </div>
  );
});

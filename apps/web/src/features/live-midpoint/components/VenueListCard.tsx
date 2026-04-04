import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { RankedVenue } from "../lib/venue-ranking";
import { formatDistance } from "../lib/geo-math";
import "../styles/live-midpoint.css";

interface VenueListCardProps {
  venues: RankedVenue[];
  loading: boolean;
  selectedVenue: RankedVenue | null;
  onSelectVenue: (venue: RankedVenue | null) => void;
}

/** Bottom card listing nearby venues ranked by composite score. */
export default memo(function VenueListCard({
  venues,
  loading,
  selectedVenue,
  onSelectVenue,
}: VenueListCardProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="live-venues live-glass">
        <div className="live-venues-header">
          <span className="live-venues-title">{t("live.searchingVenues")}</span>
        </div>
        <div className="live-venues-shimmer">
          <div className="live-venue-skeleton live-waiting-shimmer" />
          <div className="live-venue-skeleton live-waiting-shimmer" />
          <div className="live-venue-skeleton live-waiting-shimmer" />
        </div>
      </div>
    );
  }

  if (venues.length === 0) {
    return (
      <div className="live-venues live-glass">
        <div className="live-venues-header">
          <span className="live-venues-title">{t("live.nearbyVenues")}</span>
        </div>
        <div className="live-venue-empty">{t("live.noVenues")}</div>
      </div>
    );
  }

  return (
    <div className="live-venues live-glass">
      <div className="live-venues-header">
        <span className="live-venues-title">{t("live.nearbyVenues")}</span>
        {selectedVenue && (
          <button
            type="button"
            className="live-venues-clear"
            onClick={() => onSelectVenue(null)}
          >
            {t("live.clearVenue")}
          </button>
        )}
      </div>
      <div className="live-venues-list" role="listbox">
        {venues.map((v) => (
          <button
            key={v.id}
            type="button"
            role="option"
            aria-selected={selectedVenue?.id === v.id}
            className={`live-venue-item${selectedVenue?.id === v.id ? " live-venue-item--selected" : ""}`}
            onClick={() => onSelectVenue(selectedVenue?.id === v.id ? null : v)}
          >
            <span className="live-venue-name">{v.displayName}</span>
            <span className="live-venue-meta">
              {v.rating > 0 && (
                <span className="live-venue-rating">
                  &#9733; {v.rating.toFixed(1)}
                </span>
              )}
              {v.distanceFromMidpoint != null && (
                <span>{formatDistance(v.distanceFromMidpoint)}</span>
              )}
              {v.openNow && (
                <span className="live-venue-open">{t("live.openNow")}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});

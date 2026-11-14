import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { RankedVenue } from "../lib/venue-ranking";
import { formatDistance } from "../lib/geo-math";
import type { VenueStatus } from "../graph/types";
import "../styles/live-midpoint.css";

interface VenueListCardProps {
  /** The top five, plus the picked venue wherever it now ranks. */
  venues: readonly RankedVenue[];
  /** What to say while there is no list to show. */
  status: VenueStatus;
  selectedVenue: RankedVenue | null;
  onSelectVenue: (venue: RankedVenue | null) => void;
}

/**
 * Bottom card listing nearby venues ranked by composite score.
 *
 * A list is shown whenever there is one: through a refresh, and after a
 * failed search that left an earlier answer or a pinned pick to show. It
 * used to go by a single `loading` flag, which put up the skeleton over the
 * list on every refresh, and said "No venues found" both before the first
 * search had even gone out and when it had failed.
 */
export default memo(function VenueListCard({
  venues,
  status,
  selectedVenue,
  onSelectVenue,
}: VenueListCardProps) {
  const { t } = useTranslation();

  if (venues.length === 0) {
    if (status === "idle") return null;
    if (status === "searching") {
      return (
        <div className="live-venues live-glass">
          <div className="live-venues-header">
            <span className="live-venues-title">
              {t("live.searchingVenues")}
            </span>
          </div>
          <div className="live-venues-shimmer">
            <div className="live-venue-skeleton live-waiting-shimmer" />
            <div className="live-venue-skeleton live-waiting-shimmer" />
            <div className="live-venue-skeleton live-waiting-shimmer" />
          </div>
        </div>
      );
    }
    const failed = status === "failed";
    return (
      <div className="live-venues live-glass">
        <div className="live-venues-header">
          <span className="live-venues-title">{t("live.nearbyVenues")}</span>
        </div>
        <div className="live-venue-empty" role={failed ? "status" : undefined}>
          {t(failed ? "live.venuesFailed" : "live.noVenues")}
        </div>
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
              {/* bdi: in a Hebrew row "1.2 km" was laid out "km 1.2". */}
              {v.distanceFromMidpoint != null && (
                <span>
                  <bdi>{formatDistance(v.distanceFromMidpoint)}</bdi>
                </span>
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

import { useTranslation } from "react-i18next";

interface VenueCardProps {
  name: string;
  rating: number | null;
  distance_to_centroid_m: number;
  open_now: boolean | null;
  score: number;
  vicinity: string | null;
  types: string[];
  user_ratings_total: number | null;
  place_id: string;
  lat: number;
  lng: number;
  expanded: boolean;
  selected: boolean;
  onVote?: (placeId: string) => void;
  voted?: boolean;
  voteCount?: number;
}

/** Human-readable category labels */
const TYPE_LABELS: Record<string, string> = {
  cafe: "Cafe",
  coffee_shop: "Coffee",
  restaurant: "Restaurant",
  steak_house: "Steak",
  barbecue_restaurant: "BBQ",
  park: "Park",
  shopping_mall: "Mall",
  pharmacy: "Pharmacy",
  bar: "Bar",
  live_music_venue: "Live Music",
  tourist_attraction: "Attraction",
  event_venue: "Events",
  travel_agency: "Travel",
  observation_deck: "Viewpoint",
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t.replace(/_/g, " ");
}

export default function VenueCard({
  name,
  rating,
  distance_to_centroid_m,
  open_now,
  score,
  vicinity,
  types,
  user_ratings_total,
  place_id,
  lat,
  lng,
  expanded,
  selected,
  onVote,
  voted = false,
  voteCount = 0,
}: VenueCardProps) {
  const { t } = useTranslation();

  const distanceText =
    distance_to_centroid_m < 1000
      ? `${Math.round(distance_to_centroid_m)}m`
      : `${(distance_to_centroid_m / 1000).toFixed(1)}km`;

  const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  const wazeUrl = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

  const cardClass = [
    "venue-card",
    expanded && "venue-card-expanded",
    selected && "venue-card-selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClass}>
      {/* Compact row — always visible */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-sm text-start truncate flex-1">
          {name}
        </h3>
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {rating !== null ? `${rating} ★` : t("venue.noRating")}
        </span>
        <span className="text-xs text-gray-400 whitespace-nowrap">
          {distanceText}
        </span>
        {open_now === true && (
          <span className="text-xs text-green-600 whitespace-nowrap">
            {t("venue.open")}
          </span>
        )}
        {open_now === false && (
          <span className="text-xs text-gray-400 whitespace-nowrap">
            {t("venue.closed")}
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="venue-card-details">
          {vicinity && (
            <p className="text-xs text-gray-500 text-start">{vicinity}</p>
          )}

          <div className="flex items-center flex-wrap gap-1.5">
            {types.slice(0, 4).map((tp) => (
              <span key={tp} className="venue-type-pill">
                {typeLabel(tp)}
              </span>
            ))}
          </div>

          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>
              {user_ratings_total !== null
                ? t("venue.reviews", {
                    count: user_ratings_total.toLocaleString(),
                  })
                : ""}
            </span>
            <span>{t("venue.score", { score: score.toFixed(2) })}</span>
          </div>

          {/* Navigation links */}
          <div className="flex items-center gap-3">
            <a
              href={gmapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="venue-nav-link"
              onClick={(e) => e.stopPropagation()}
            >
              {t("venue.navigateGoogle")} →
            </a>
            <a
              href={wazeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="venue-nav-link"
              onClick={(e) => e.stopPropagation()}
            >
              {t("venue.navigateWaze")} →
            </a>
          </div>

          {/* Vote button */}
          {onVote && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!voted) onVote(place_id);
              }}
              className={`venue-vote-btn ${voted ? "venue-vote-btn-voted" : "venue-vote-btn-active"}`}
              disabled={voted}
            >
              {voted
                ? `✓ ${t("venue.voted")}${voteCount > 0 ? ` · ${t("venue.votes", { count: voteCount })}` : ""}`
                : t("venue.vote")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { useTranslation } from "react-i18next";
import type { Venue } from "../../../../packages/shared/types";
import VenueCard from "./VenueCard";

interface VenueListProps {
  venues: Venue[];
  onVenueClick?: (v: Venue) => void;
}

export default function VenueList({ venues, onVenueClick }: VenueListProps) {
  const { t } = useTranslation();

  if (venues.length === 0) return null;

  return (
    <div
      data-testid="venue-list"
      role="list"
      aria-label={t("venues.title")}
      className="absolute bottom-0 left-0 right-0 z-10 max-h-64 overflow-y-auto bg-white/90 backdrop-blur rounded-t-2xl shadow-xl p-3 venue-list-enter"
    >
      <h2 className="font-semibold text-sm text-gray-700 mb-2">
        {t("venues.title")}
      </h2>
      {venues.map((v) => (
        <div
          key={v.place_id}
          role="listitem"
          onClick={() => onVenueClick?.(v)}
          className={onVenueClick ? "cursor-pointer" : undefined}
        >
          <VenueCard
            name={v.name}
            rating={v.rating}
            distance_to_centroid_m={v.distance_to_centroid_m}
            open_now={v.open_now}
            score={v.score}
          />
        </div>
      ))}
    </div>
  );
}

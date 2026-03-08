import { useTranslation } from "react-i18next";

interface VenueCardProps {
  name: string;
  rating: number | null;
  distance_to_centroid_m: number;
  open_now: boolean | null;
  score: number;
}

export default function VenueCard({
  name,
  rating,
  distance_to_centroid_m,
  open_now,
  score,
}: VenueCardProps) {
  const { t } = useTranslation();

  const distanceText =
    distance_to_centroid_m < 1000
      ? `${Math.round(distance_to_centroid_m)}m`
      : `${(distance_to_centroid_m / 1000).toFixed(1)}km`;

  return (
    <div className="bg-white rounded-lg shadow p-4 flex flex-col gap-2">
      <h3 className="font-semibold text-base text-start">{name}</h3>
      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>{rating !== null ? `${rating} ★` : t("venue.noRating")}</span>
        <span>{distanceText}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span
          className={open_now === true ? "text-green-600" : "text-gray-400"}
        >
          {open_now === true
            ? t("venue.open")
            : open_now === false
              ? t("venue.closed")
              : ""}
        </span>
        <span className="text-gray-400 text-end">
          {t("venue.score", { score: score.toFixed(2) })}
        </span>
      </div>
    </div>
  );
}

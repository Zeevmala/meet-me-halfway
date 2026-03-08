from math import log

from geographiclib.geodesic import Geodesic


def rank_venues(
    venues: list[dict],
    centroid: tuple[float, float],
    search_radius: float,
) -> list[dict]:
    """
    Rank venues by composite score.

    Score = 0.40*rating_norm + 0.30*distance_penalty + 0.20*popularity_norm + 0.10*open_now_bonus
    """
    if not venues:
        return []

    clat, clng = centroid
    max_ratings = max(v.get("user_ratings_total") or 0 for v in venues)

    for venue in venues:
        rating = venue.get("rating") or 1.0
        user_ratings_total = venue.get("user_ratings_total") or 0
        open_now = venue.get("open_now") or False
        vlat = venue["lat"]
        vlng = venue["lng"]

        rating_norm = (rating - 1) / 4

        dist = Geodesic.WGS84.Inverse(clat, clng, vlat, vlng)["s12"]
        distance_penalty = max(0.0, 1.0 - dist / search_radius)

        if max_ratings == 0:
            popularity_norm = 0.0
        else:
            popularity_norm = log(user_ratings_total + 1) / log(max_ratings + 1)

        open_now_bonus = 1.0 if open_now else 0.0

        venue["score"] = (
            0.40 * rating_norm
            + 0.30 * distance_penalty
            + 0.20 * popularity_norm
            + 0.10 * open_now_bonus
        )
        venue["distance_to_centroid_m"] = dist

    venues.sort(key=lambda v: v["score"], reverse=True)
    return venues

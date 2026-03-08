import itertools

from geographiclib.geodesic import Geodesic


def dynamic_search_radius(participants: list[tuple[float, float]]) -> float:
    """
    Compute POI search radius based on max pairwise geodesic distance.

    Returns a value in meters clamped to [500, 5000].
    """
    if len(participants) <= 1:
        return 500.0

    max_dist = 0.0
    for (lat1, lon1), (lat2, lon2) in itertools.combinations(participants, 2):
        result = Geodesic.WGS84.Inverse(lat1, lon1, lat2, lon2)
        dist = result["s12"]
        if dist > max_dist:
            max_dist = dist

    return max(500.0, min(5000.0, max_dist / 4))

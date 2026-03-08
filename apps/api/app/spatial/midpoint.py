import math

from geographiclib.geodesic import Geodesic

# WGS84 ellipsoid constants
_A = 6378137.0  # semi-major axis (m)
_F = 1 / 298.257223563  # flattening
_E2 = 2 * _F - _F**2  # first eccentricity squared


def _to_ecef(lat_deg: float, lon_deg: float) -> tuple[float, float, float]:
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    n_prime = _A / math.sqrt(1 - _E2 * math.sin(lat) ** 2)
    x = n_prime * math.cos(lat) * math.cos(lon)
    y = n_prime * math.cos(lat) * math.sin(lon)
    z = n_prime * (1 - _E2) * math.sin(lat)
    return x, y, z


def _from_ecef(x: float, y: float, z: float) -> tuple[float, float]:
    lon = math.atan2(y, x)
    p = math.sqrt(x**2 + y**2)
    # Iterative Bowring method
    lat = math.atan2(z, p * (1 - _E2))
    for _ in range(10):
        n_prime = _A / math.sqrt(1 - _E2 * math.sin(lat) ** 2)
        lat = math.atan2(z + _E2 * n_prime * math.sin(lat), p)
    return math.degrees(lat), math.degrees(lon)


def geodesic_centroid(participants: list[tuple[float, float]]) -> tuple[float, float]:
    """
    Compute the geodesic centroid of participant locations.

    Args:
        participants: list of (lat, lng) tuples in WGS84

    Returns:
        (lat, lng) centroid tuple
    """
    if len(participants) == 0:
        raise ValueError("participants must not be empty")

    if len(participants) == 1:
        return participants[0]

    if len(participants) == 2:
        lat1, lon1 = participants[0]
        lat2, lon2 = participants[1]
        line = Geodesic.WGS84.Inverse(lat1, lon1, lat2, lon2)
        result = Geodesic.WGS84.Direct(lat1, lon1, line["azi1"], line["s12"] / 2)
        return (result["lat2"], result["lon2"])

    # N >= 3: ECEF arithmetic mean
    xs, ys, zs = [], [], []
    for lat, lng in participants:
        x, y, z = _to_ecef(lat, lng)
        xs.append(x)
        ys.append(y)
        zs.append(z)

    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    z_mean = sum(zs) / len(zs)

    lat_out, lon_out = _from_ecef(x_mean, y_mean, z_mean)
    return (lat_out, lon_out)

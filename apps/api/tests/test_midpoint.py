import math

from app.spatial.midpoint import geodesic_centroid

TEL_AVIV = (32.0853, 34.7818)
JERUSALEM = (31.7683, 35.2137)
HAIFA = (32.7940, 34.9896)
NYC = (40.7128, -74.0060)
LA = (34.0522, -118.2437)


def test_tel_aviv_jerusalem_midpoint():
    result = geodesic_centroid([TEL_AVIV, JERUSALEM])
    lat, lng = result
    # Expected approx (31.927, 34.998)
    assert abs(lat - 31.927) < 0.001
    assert abs(lng - 34.998) < 0.001


def test_nyc_la_midpoint_sanity():
    result = geodesic_centroid([NYC, LA])
    lat, lng = result
    # Result lat should be between LA and NYC lats
    assert min(NYC[0], LA[0]) <= lat <= max(NYC[0], LA[0])
    # Result lng should be between LA and NYC lngs
    assert min(NYC[1], LA[1]) <= lng <= max(NYC[1], LA[1])


def test_same_location_n2():
    point = (32.0853, 34.7818)
    result = geodesic_centroid([point, point])
    assert abs(result[0] - point[0]) < 1e-6
    assert abs(result[1] - point[1]) < 1e-6


def test_three_participants_within_bounding_box():
    participants = [TEL_AVIV, JERUSALEM, HAIFA]
    result = geodesic_centroid(participants)
    lat, lng = result
    lats = [p[0] for p in participants]
    lngs = [p[1] for p in participants]
    assert min(lats) <= lat <= max(lats)
    assert min(lngs) <= lng <= max(lngs)


def test_five_participants_returns_valid_point():
    participants = [
        (51.5074, -0.1278),  # London
        (48.8566, 2.3522),  # Paris
        (52.5200, 13.4050),  # Berlin
        (41.9028, 12.4964),  # Rome
        (40.4168, -3.7038),  # Madrid
    ]
    result = geodesic_centroid(participants)
    lat, lng = result
    assert isinstance(lat, float)
    assert isinstance(lng, float)
    lats = [p[0] for p in participants]
    lngs = [p[1] for p in participants]
    assert min(lats) <= lat <= max(lats)
    assert min(lngs) <= lng <= max(lngs)


def test_antipodal_no_exception():
    result = geodesic_centroid([(0.0, 0.0), (0.0, 180.0)])
    lat, lng = result
    assert math.isfinite(lat)
    assert math.isfinite(lng)


def test_single_participant():
    point = (32.0853, 34.7818)
    result = geodesic_centroid([point])
    assert result == point


def test_three_identical_points():
    point = (32.0853, 34.7818)
    result = geodesic_centroid([point, point, point])
    assert abs(result[0] - point[0]) < 1e-5
    assert abs(result[1] - point[1]) < 1e-5

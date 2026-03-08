from app.spatial.radius import dynamic_search_radius


def test_two_identical_points_returns_minimum():
    result = dynamic_search_radius([(32.0, 34.0), (32.0, 34.0)])
    assert result == 500.0


def test_two_points_one_km_apart_clamped_to_min():
    # ~1km apart: 250m / 4 = 250, clamped to 500
    # Approximately 1km north
    result = dynamic_search_radius([(32.0, 34.0), (32.009, 34.0)])
    assert result == 500.0


def test_two_points_8km_apart():
    # ~8km: 8000/4 = 2000, within [500, 5000]
    result = dynamic_search_radius([(32.0, 34.0), (32.072, 34.0)])
    assert 1800.0 <= result <= 2200.0


def test_two_points_30km_apart_clamped_to_max():
    # ~30km: 30000/4 = 7500, clamped to 5000
    result = dynamic_search_radius([(32.0, 34.0), (32.270, 34.0)])
    assert result == 5000.0


def test_three_participants_max_pairwise():
    # Points roughly 10km apart max pairwise → radius ≈ 2500
    p1 = (32.0, 34.0)
    p2 = (32.090, 34.0)  # ~10km north
    p3 = (32.045, 34.0)  # ~5km north (between p1 and p2)
    result = dynamic_search_radius([p1, p2, p3])
    assert 2000.0 <= result <= 3000.0


def test_single_participant_returns_minimum():
    result = dynamic_search_radius([(32.0, 34.0)])
    assert result == 500.0

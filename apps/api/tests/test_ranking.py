"""
POI ranking formula tests — 10+ synthetic scenarios.
Score = 0.40*rating_norm + 0.30*distance_penalty + 0.20*popularity_norm + 0.10*open_now_bonus
"""

from __future__ import annotations

import math

import pytest

from app.spatial.ranking import rank_venues

CENTROID = (32.0, 34.0)
SEARCH_RADIUS = 2000.0  # metres


def make_venue(
    name: str,
    lat: float,
    lng: float,
    rating: float,
    user_ratings_total: int,
    open_now: bool,
) -> dict:
    return {
        "place_id": f"place_{name}",
        "name": name,
        "lat": lat,
        "lng": lng,
        "rating": rating,
        "user_ratings_total": user_ratings_total,
        "open_now": open_now,
    }


# ── Basic ordering ─────────────────────────────────────────────────────────────


def test_high_rating_beats_low_rating():
    venues = [
        make_venue("low", *CENTROID, 2.0, 100, False),
        make_venue("high", *CENTROID, 5.0, 100, False),
    ]
    assert rank_venues(venues, CENTROID, SEARCH_RADIUS)[0]["name"] == "high"


def test_close_venue_beats_far_venue():
    venues = [
        make_venue("far", CENTROID[0] + 0.01, CENTROID[1], 4.0, 100, False),
        make_venue("close", *CENTROID, 4.0, 100, False),
    ]
    assert rank_venues(venues, CENTROID, SEARCH_RADIUS)[0]["name"] == "close"


def test_open_venue_beats_closed():
    venues = [
        make_venue("closed", *CENTROID, 4.0, 100, False),
        make_venue("open", *CENTROID, 4.0, 100, True),
    ]
    assert rank_venues(venues, CENTROID, SEARCH_RADIUS)[0]["name"] == "open"


def test_high_popularity_beats_low():
    venues = [
        make_venue("unpopular", *CENTROID, 4.0, 10, False),
        make_venue("popular", *CENTROID, 4.0, 1000, False),
    ]
    assert rank_venues(venues, CENTROID, SEARCH_RADIUS)[0]["name"] == "popular"


# ── Hand-computed scores ───────────────────────────────────────────────────────


def test_perfect_score_at_centroid_no_ratings():
    """rating=5, dist=0, ratings=0, open=True → 0.40*1+0.30*1+0.20*0+0.10*1 = 0.80"""
    venues = [make_venue("v", *CENTROID, 5.0, 0, True)]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert abs(result[0]["score"] - 0.80) < 1e-9


def test_minimum_score():
    """rating=1, dist=radius, ratings=0, open=False → all components 0 → score=0"""
    # Place venue at exactly search_radius metres away in latitude
    # 2000 m ≈ 0.01798° latitude
    far_lat = CENTROID[0] + 0.01798
    venues = [make_venue("v", far_lat, CENTROID[1], 1.0, 0, False)]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert result[0]["score"] == pytest.approx(0.0, abs=0.01)


def test_venue_beyond_radius_distance_penalty_clamped_to_zero():
    """Venues outside search radius get distance_penalty=0 (clamped, not negative)."""
    # ~5000 m away — well beyond SEARCH_RADIUS=2000
    far_lat = CENTROID[0] + 0.045
    venues = [make_venue("v", far_lat, CENTROID[1], 3.0, 0, False)]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    # distance_penalty = max(0, ...) — must not go negative
    assert result[0]["score"] >= 0.0


def test_popularity_norm_with_single_venue():
    """When only one venue, max_ratings = its own count → popularity_norm = 1.0"""
    venues = [make_venue("v", *CENTROID, 3.0, 500, False)]
    # rating_norm=(3-1)/4=0.5, dist=0→penalty=1.0, pop=log(501)/log(501)=1.0, open=0
    # score = 0.40*0.5 + 0.30*1.0 + 0.20*1.0 + 0.10*0 = 0.20+0.30+0.20 = 0.70
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert abs(result[0]["score"] - 0.70) < 1e-9


def test_score_uses_log_normalization():
    """Venue with 100 ratings normalized against 1000-rating venue."""
    venues = [
        make_venue("few", *CENTROID, 4.0, 100, False),
        make_venue("many", *CENTROID, 4.0, 1000, False),
    ]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    few_score = next(v["score"] for v in result if v["name"] == "few")
    many_score = next(v["score"] for v in result if v["name"] == "many")
    expected_few_pop = math.log(101) / math.log(1001)
    expected_many_pop = math.log(1001) / math.log(1001)
    assert few_score < many_score
    assert abs(few_score - (0.40 * 0.75 + 0.30 * 1.0 + 0.20 * expected_few_pop)) < 1e-6
    assert abs(many_score - (0.40 * 0.75 + 0.30 * 1.0 + 0.20 * expected_many_pop)) < 1e-6


# ── Edge cases ─────────────────────────────────────────────────────────────────


def test_empty_input_returns_empty():
    assert rank_venues([], CENTROID, SEARCH_RADIUS) == []


def test_single_venue_returned():
    venues = [make_venue("only", *CENTROID, 4.0, 50, True)]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert len(result) == 1
    assert result[0]["name"] == "only"


def test_score_field_added_to_venue():
    venues = [make_venue("v", *CENTROID, 4.0, 100, True)]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert "score" in result[0]
    assert "distance_to_centroid_m" in result[0]


def test_sorted_descending():
    venues = [
        make_venue("a", *CENTROID, 2.0, 10, False),
        make_venue("b", *CENTROID, 5.0, 500, True),
        make_venue("c", *CENTROID, 3.5, 100, False),
    ]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    scores = [v["score"] for v in result]
    assert scores == sorted(scores, reverse=True)


def test_five_venues_all_scored():
    venues = [
        make_venue(
            f"v{i}", CENTROID[0] + i * 0.001, CENTROID[1], 3.0 + i * 0.3, i * 50, i % 2 == 0
        )
        for i in range(5)
    ]
    result = rank_venues(venues, CENTROID, SEARCH_RADIUS)
    assert len(result) == 5
    assert all(0.0 <= v["score"] <= 1.0 for v in result)

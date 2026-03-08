"""
Shared pytest fixtures for the Meet Me Halfway API test suite.
"""

from __future__ import annotations

import httpx
import pytest
from httpx import ASGITransport

from app.main import create_app

# ── App / client fixtures ─────────────────────────────────────────────────────


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── Known coordinate fixtures ─────────────────────────────────────────────────


@pytest.fixture
def tel_aviv() -> tuple[float, float]:
    """WGS84 (lat, lng) — PostGIS/Python order."""
    return (32.0853, 34.7818)


@pytest.fixture
def jerusalem() -> tuple[float, float]:
    return (31.7683, 35.2137)


@pytest.fixture
def haifa() -> tuple[float, float]:
    return (32.7940, 34.9896)


@pytest.fixture
def sample_points(tel_aviv, jerusalem, haifa) -> list[tuple[float, float]]:
    return [tel_aviv, jerusalem, haifa]


# ── Synthetic venue fixtures ──────────────────────────────────────────────────


@pytest.fixture
def sample_venues() -> list[dict]:
    """Synthetic POI data near the Tel Aviv–Jerusalem centroid (~31.93, 34.998)."""
    return [
        {
            "place_id": "ChIJ_cafe_001",
            "name": "Café Midpoint",
            "lat": 31.930,
            "lng": 34.998,
            "rating": 4.5,
            "user_ratings_total": 250,
            "open_now": True,
            "types": ["cafe"],
            "vicinity": "1 Middle St",
        },
        {
            "place_id": "ChIJ_rest_002",
            "name": "Restaurant Far",
            "lat": 31.960,
            "lng": 35.020,
            "rating": 4.8,
            "user_ratings_total": 800,
            "open_now": False,
            "types": ["restaurant"],
            "vicinity": "99 Far Ave",
        },
        {
            "place_id": "ChIJ_park_003",
            "name": "Park Close",
            "lat": 31.929,
            "lng": 34.997,
            "rating": 4.2,
            "user_ratings_total": 120,
            "open_now": True,
            "types": ["park"],
            "vicinity": "Park Lane",
        },
    ]

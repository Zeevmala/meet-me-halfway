"""
Tests for the Google Places API proxy service.
All HTTP calls are mocked — no real API key required.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.cache import TTLCache, places_cache
from app.services.places import _cache_key, _parse_venue, nearby_search

# ── Cache unit tests ──────────────────────────────────────────────────────────


def test_cache_miss_returns_none():
    cache = TTLCache(ttl_seconds=60)
    assert cache.get("missing") is None


def test_cache_set_and_get():
    cache = TTLCache(ttl_seconds=60)
    cache.set("k", [1, 2, 3])
    assert cache.get("k") == [1, 2, 3]


def test_cache_expired_returns_none():
    cache = TTLCache(ttl_seconds=0)
    cache.set("k", "value")
    # TTL=0 → already expired by next monotonic check
    import time

    time.sleep(0.01)
    assert cache.get("k") is None


def test_cache_delete():
    cache = TTLCache(ttl_seconds=60)
    cache.set("k", "v")
    cache.delete("k")
    assert cache.get("k") is None


def test_cache_evict_expired():
    cache = TTLCache(ttl_seconds=0)
    cache.set("a", 1)
    cache.set("b", 2)
    import time

    time.sleep(0.01)
    evicted = cache.evict_expired()
    assert evicted == 2
    assert len(cache) == 0


def test_cache_key_format():
    key = _cache_key(31.9270, 34.9980, 1200.0, "he")
    assert key == "31.9270,34.9980,1200,he"


# ── Parse venue ───────────────────────────────────────────────────────────────


def test_parse_venue_full():
    raw = {
        "id": "ChIJabc123",
        "displayName": {"text": "Café Midpoint"},
        "location": {"latitude": 31.93, "longitude": 34.998},
        "rating": 4.5,
        "userRatingCount": 250,
        "currentOpeningHours": {"openNow": True},
        "types": ["cafe", "food"],
        "formattedAddress": "1 Middle St",
        "photos": [{"name": "places/abc/photos/photo1"}],
    }
    venue = _parse_venue(raw)
    assert venue["place_id"] == "ChIJabc123"
    assert venue["name"] == "Café Midpoint"
    assert venue["lat"] == pytest.approx(31.93)
    assert venue["lng"] == pytest.approx(34.998)
    assert venue["rating"] == 4.5
    assert venue["user_ratings_total"] == 250
    assert venue["open_now"] is True
    assert "cafe" in venue["types"]
    assert venue["photo_name"] == "places/abc/photos/photo1"


def test_parse_venue_minimal():
    venue = _parse_venue({})
    assert venue["place_id"] == ""
    assert venue["name"] == ""
    assert venue["lat"] == 0.0
    assert venue["open_now"] is None
    assert venue["photo_name"] == ""


# ── nearby_search — no API key ────────────────────────────────────────────────


async def test_nearby_search_no_key_returns_empty():
    with patch("app.services.places.settings") as mock_settings:
        mock_settings.GOOGLE_PLACES_KEY = ""
        result = await nearby_search(31.93, 34.998, 1200.0)
    assert result == []


# ── nearby_search — cached response ──────────────────────────────────────────


async def test_nearby_search_returns_cached():
    key = _cache_key(31.93, 34.998, 1200.0, "en")
    cached_venues = [{"place_id": "cached_001", "name": "Cached Café"}]
    places_cache.set(key, cached_venues)

    with patch("app.services.places.settings") as mock_settings:
        mock_settings.GOOGLE_PLACES_KEY = "test-key"
        # httpx should NOT be called — cached value returned
        with patch("httpx.AsyncClient") as mock_client:
            result = await nearby_search(31.93, 34.998, 1200.0)

    assert result == cached_venues
    mock_client.assert_not_called()
    places_cache.delete(key)  # cleanup


# ── nearby_search — successful API response ───────────────────────────────────


async def test_nearby_search_parses_api_response():
    places_cache.clear()
    api_response = {
        "places": [
            {
                "id": "ChIJnew001",
                "displayName": {"text": "Test Restaurant"},
                "location": {"latitude": 31.930, "longitude": 34.998},
                "rating": 4.2,
                "userRatingCount": 80,
                "currentOpeningHours": {"openNow": False},
                "types": ["restaurant"],
                "formattedAddress": "10 Test Ave",
                "photos": [],
            }
        ]
    }

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = api_response
    mock_response.raise_for_status = MagicMock()

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=mock_response)

    with (
        patch("app.services.places.settings") as mock_settings,
        patch("httpx.AsyncClient", return_value=mock_client),
    ):
        mock_settings.GOOGLE_PLACES_KEY = "test-key"
        result = await nearby_search(31.930, 34.998, 1200.0, "en")

    assert len(result) == 1
    assert result[0]["place_id"] == "ChIJnew001"
    assert result[0]["name"] == "Test Restaurant"
    assert result[0]["open_now"] is False


# ── nearby_search — API failure returns empty ─────────────────────────────────


async def test_nearby_search_http_error_returns_empty():
    places_cache.clear()

    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=httpx.TransportError("connection reset"))

    with (
        patch("app.services.places.settings") as mock_settings,
        patch("httpx.AsyncClient", return_value=mock_client),
        patch("asyncio.sleep", new=AsyncMock()),
    ):  # skip backoff delays
        mock_settings.GOOGLE_PLACES_KEY = "test-key"
        result = await nearby_search(31.930, 34.998, 1200.0)

    assert result == []

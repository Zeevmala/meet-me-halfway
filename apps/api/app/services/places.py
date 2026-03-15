"""
Google Places API (New) — Nearby Search proxy with TTL caching and retry.

Cache key: "{lat:.4f},{lng:.4f},{radius:.0f},{language}"
TTL: 300 s (5 min) — balances freshness vs. cost (risk R1 in plan.md).

Coordinate order note: Places API (New) uses latitude then longitude in the
request body; this matches our internal (lat, lng) convention.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import settings
from app.services.cache import places_cache

logger = logging.getLogger(__name__)

_PLACES_URL = "https://places.googleapis.com/v1/places:searchNearby"
_FIELD_MASK = (
    "places.id,"
    "places.displayName,"
    "places.location,"
    "places.rating,"
    "places.userRatingCount,"
    "places.currentOpeningHours.openNow,"
    "places.types,"
    "places.formattedAddress,"
    "places.photos"
)
_MAX_RESULTS = 10
_TIMEOUT = 10.0
_MAX_RETRIES = 3
_RETRY_STATUSES = {429, 500, 502, 503, 504}


def _cache_key(lat: float, lng: float, radius_m: float, language: str) -> str:
    # 4 decimal places ≈ 11 m precision — fine for a 500–5000 m search radius
    return f"{lat:.4f},{lng:.4f},{radius_m:.0f},{language}"


def _parse_venue(place: dict) -> dict:
    loc = place.get("location", {})
    photos = place.get("photos", [])
    photo_name = photos[0].get("name", "") if photos else ""
    return {
        "place_id": place.get("id", ""),
        "name": place.get("displayName", {}).get("text", ""),
        # lat/lng stored separately — GeoJSON consumers must flip to [lng, lat]
        "lat": loc.get("latitude", 0.0),
        "lng": loc.get("longitude", 0.0),
        "rating": place.get("rating"),
        "user_ratings_total": place.get("userRatingCount"),
        "open_now": place.get("currentOpeningHours", {}).get("openNow"),
        "types": place.get("types", []),
        "vicinity": place.get("formattedAddress"),
        "photo_name": photo_name,
    }


async def nearby_search(
    lat: float,
    lng: float,
    radius_m: float,
    language: str = "en",
) -> list[dict]:
    """
    Return nearby POIs from Google Places API (New), with TTL caching.

    Args:
        lat: Centroid latitude (WGS84).
        lng: Centroid longitude (WGS84).
        radius_m: Search radius in metres [500, 5000].
        language: BCP-47 language code for display names.

    Returns:
        List of venue dicts; empty list on API unavailability.
    """
    if not settings.GOOGLE_PLACES_KEY:
        logger.warning("GOOGLE_PLACES_KEY not set — returning empty venues")
        return []

    key = _cache_key(lat, lng, radius_m, language)
    cached = places_cache.get(key)
    if cached is not None:
        logger.debug("Places cache hit: %s", key)
        return cached  # type: ignore[return-value]

    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": settings.GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": _FIELD_MASK,
        "Accept-Language": language,
    }
    body = {
        "locationRestriction": {
            "circle": {
                "center": {"latitude": lat, "longitude": lng},
                "radius": radius_m,
            }
        },
        "maxResultCount": _MAX_RESULTS,
    }

    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.post(_PLACES_URL, json=body, headers=headers)
                if resp.status_code in _RETRY_STATUSES:
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request, response=resp
                    )
                resp.raise_for_status()
                venues = [_parse_venue(p) for p in resp.json().get("places", [])]
                places_cache.set(key, venues)
                logger.info(
                    "Places API: %d venues at (%.4f, %.4f) r=%.0fm lang=%s",
                    len(venues),
                    lat,
                    lng,
                    radius_m,
                    language,
                )
                return venues
            except (httpx.HTTPStatusError, httpx.TransportError) as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    backoff = 2**attempt
                    logger.warning(
                        "Places API attempt %d/%d failed (%s), retrying in %ds",
                        attempt + 1,
                        _MAX_RETRIES,
                        exc,
                        backoff,
                    )
                    await asyncio.sleep(backoff)

    logger.error("Places API failed after %d attempts: %s", _MAX_RETRIES, last_exc)
    return []

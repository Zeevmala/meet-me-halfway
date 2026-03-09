"""
Firebase Realtime Database sync.

All writes are fire-and-forget: errors are logged but never propagate to the
caller. Firebase Admin SDK is synchronous; calls are offloaded to a thread
pool via asyncio.to_thread() so they don't block the event loop.

RTDB structure (matches spec.md §4.2):
  /sessions/{session_id}/
    participants/{participant_id}/
      display_name: str
      lat: float
      lng: float
      updated_at: int   ← epoch ms
    centroid/
      lat: float
      lng: float
"""

from __future__ import annotations

import asyncio
import json
import logging
import time

logger = logging.getLogger(__name__)

_firebase_ready = False


def initialize_firebase() -> None:
    """Initialize Firebase Admin SDK. Silent no-op when credentials absent."""
    global _firebase_ready
    from app.config import settings

    if not settings.FIREBASE_CREDENTIALS_JSON:
        logger.warning("FIREBASE_CREDENTIALS_JSON not set — Firebase sync disabled")
        return

    try:
        import firebase_admin
        from firebase_admin import credentials

        if not firebase_admin._apps:
            cred_dict = json.loads(settings.FIREBASE_CREDENTIALS_JSON)
            cred = credentials.Certificate(cred_dict)
            db_url = settings.FIREBASE_DATABASE_URL
            if not db_url:
                logger.warning("FIREBASE_DATABASE_URL not set — RTDB writes will fail")
            firebase_admin.initialize_app(
                cred,
                {"databaseURL": db_url},
            )
        _firebase_ready = True
        logger.info("Firebase Admin SDK initialized")
    except Exception as exc:
        logger.error("Firebase initialization failed: %s", exc)


def _is_ready() -> bool:
    return _firebase_ready


async def _fb_set(path: str, data: dict) -> None:
    """Write data to a Firebase RTDB path in a thread (non-blocking)."""
    from firebase_admin import db

    ref = db.reference(path)
    await asyncio.to_thread(ref.set, data)


async def write_participant_location(
    session_id: str,
    participant_id: str,
    display_name: str,
    lat: float,
    lng: float,
) -> None:
    """
    Sync participant location to Firebase RTDB.

    Path: /sessions/{session_id}/participants/{participant_id}
    Coordinate note: stored as {lat, lng} per GeoJSON convention in RTDB;
    PostGIS and Python spatial ops use (lat, lng) tuples internally.
    """
    if not _is_ready():
        logger.debug("Firebase not ready — skipping participant write %s", participant_id)
        return
    try:
        await _fb_set(
            f"/sessions/{session_id}/participants/{participant_id}",
            {
                "display_name": display_name,
                "lat": lat,
                "lng": lng,
                "updated_at": int(time.time() * 1000),
            },
        )
    except Exception as exc:
        logger.error(
            "Firebase write_participant_location failed (session=%s participant=%s): %s",
            session_id,
            participant_id,
            exc,
        )


async def write_centroid(session_id: str, lat: float, lng: float) -> None:
    """
    Write computed centroid to Firebase RTDB (server-only write, security
    rules deny client writes to this path).
    """
    if not _is_ready():
        logger.debug("Firebase not ready — skipping centroid write for %s", session_id)
        return
    try:
        await _fb_set(
            f"/sessions/{session_id}/centroid",
            {"lat": lat, "lng": lng},
        )
    except Exception as exc:
        logger.error("Firebase write_centroid failed (session=%s): %s", session_id, exc)


async def write_session_status(session_id: str, status: str) -> None:
    """Sync session status change to Firebase (e.g. 'completed', 'expired')."""
    if not _is_ready():
        return
    try:
        await _fb_set(f"/sessions/{session_id}/status", status)
    except Exception as exc:
        logger.error("Firebase write_session_status failed (session=%s): %s", session_id, exc)

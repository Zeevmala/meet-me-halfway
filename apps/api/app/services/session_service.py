"""
Session business logic — all PostGIS queries via SQLAlchemy async.

Coordinate order conventions:
  - Internal Python / SQLAlchemy: (lat, lng) tuples
  - PostGIS / WKT geometry:       POINT(lng lat)   ← X=lng, Y=lat
  - Firebase RTDB:                {lat, lng}
  - GeoJSON / Mapbox:             [lng, lat]
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from geoalchemy2.elements import WKTElement
from geoalchemy2.shape import to_shape
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.db import Participant, SelectedVenue, Session
from app.models.schemas import (
    CreateSessionRequest,
    JoinResponse,
    JoinSessionRequest,
    LatLng,
    MidpointResponse,
    SessionOut,
    UpdateLocationRequest,
    VenueOut,
    VoteRequest,
    VoteResponse,
)
from app.services.firebase import (
    write_centroid,
    write_participant_location,
    write_session_status,
)
from app.services.places import nearby_search
from app.spatial.midpoint import geodesic_centroid
from app.spatial.radius import dynamic_search_radius
from app.spatial.ranking import rank_venues

# ── Geometry helpers ──────────────────────────────────────────────────────────


def _point(lat: float, lng: float) -> WKTElement:
    # WKT uses (lng lat) — X is longitude, Y is latitude
    return WKTElement(f"POINT({lng} {lat})", srid=4326)


def _latlng(geom: object) -> tuple[float, float]:
    """Extract (lat, lng) from a GeoAlchemy2 geometry element."""
    shape = to_shape(geom)  # type: ignore[arg-type]
    return shape.y, shape.x  # shapely: y=lat, x=lng


# ── Internal helpers ──────────────────────────────────────────────────────────


async def _get_active_session(db: AsyncSession, session_id: str) -> Session:
    result = await db.execute(select(Session).where(Session.id == session_id))
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status in ("expired", "completed") or session.expires_at < datetime.now(UTC):
        raise HTTPException(status_code=410, detail="Session has expired")
    return session


def _session_out(session: Session, participant_count: int) -> SessionOut:
    return SessionOut(
        session_id=session.id,
        status=session.status,
        locale=session.locale,
        created_at=session.created_at,
        expires_at=session.expires_at,
        participant_count=participant_count,
        max_participants=session.max_participants,
    )


def _venue_out(v: dict) -> VenueOut:
    return VenueOut(
        place_id=v["place_id"],
        name=v["name"],
        lat=v["lat"],
        lng=v["lng"],
        rating=v.get("rating"),
        user_ratings_total=v.get("user_ratings_total"),
        open_now=v.get("open_now"),
        distance_to_centroid_m=v["distance_to_centroid_m"],
        score=v["score"],
        types=v.get("types", []),
        vicinity=v.get("vicinity"),
    )


# ── Service functions ─────────────────────────────────────────────────────────


async def create_session(db: AsyncSession, request: CreateSessionRequest) -> SessionOut:
    now = datetime.now(UTC)
    expires_at = now + timedelta(hours=settings.SESSION_TTL_HOURS)
    session = Session(
        id=str(uuid.uuid4()),  # set in Python — no DB round-trip needed
        created_at=now,  # server_default fallback for migrations; explicit here
        status="active",
        expires_at=expires_at,
        locale=request.locale,
        max_participants=request.max_participants,
    )
    db.add(session)
    await db.flush()
    return _session_out(session, participant_count=0)


async def get_session(db: AsyncSession, session_id: str) -> SessionOut:
    session = await _get_active_session(db, session_id)
    count_result = await db.execute(
        select(func.count()).select_from(Participant).where(Participant.session_id == session_id)
    )
    count = count_result.scalar_one()
    return _session_out(session, participant_count=count)


async def join_session(
    db: AsyncSession, session_id: str, request: JoinSessionRequest
) -> JoinResponse:
    session = await _get_active_session(db, session_id)

    count_result = await db.execute(
        select(func.count()).select_from(Participant).where(Participant.session_id == session_id)
    )
    count = count_result.scalar_one()
    if count >= session.max_participants:
        raise HTTPException(status_code=409, detail="Session is full")

    participant = Participant(
        id=str(uuid.uuid4()),  # explicit — available immediately post-construction
        session_id=session_id,
        display_name=request.display_name,
        phone_hash=request.phone_hash,
        location=_point(request.location.lat, request.location.lng),
        updated_at=datetime.now(UTC),
    )
    db.add(participant)
    await db.flush()

    # Sync to Firebase RTDB — non-fatal on error
    await write_participant_location(
        session_id,
        participant.id,
        request.display_name,
        request.location.lat,
        request.location.lng,
    )

    return JoinResponse(participant_id=participant.id, session_id=session_id)


async def update_location(
    db: AsyncSession, session_id: str, request: UpdateLocationRequest
) -> None:
    await _get_active_session(db, session_id)

    result = await db.execute(
        select(Participant).where(
            Participant.id == request.participant_id,
            Participant.session_id == session_id,
        )
    )
    participant = result.scalar_one_or_none()
    if participant is None:
        raise HTTPException(status_code=404, detail="Participant not found in this session")

    participant.location = _point(request.location.lat, request.location.lng)
    participant.updated_at = datetime.now(UTC)
    await db.flush()

    # Sync updated location to Firebase RTDB
    await write_participant_location(
        session_id,
        request.participant_id,
        participant.display_name,
        request.location.lat,
        request.location.lng,
    )


async def get_midpoint(db: AsyncSession, session_id: str) -> MidpointResponse:
    session = await _get_active_session(db, session_id)

    result = await db.execute(
        select(Participant).where(
            Participant.session_id == session_id,
            Participant.location.is_not(None),
        )
    )
    participants = result.scalars().all()

    if len(participants) < 2:
        raise HTTPException(
            status_code=422,
            detail=f"Need at least 2 participants with locations, have {len(participants)}",
        )

    # (lat, lng) tuples for spatial functions
    coords = [_latlng(p.location) for p in participants]
    centroid_lat, centroid_lng = geodesic_centroid(coords)
    radius = dynamic_search_radius(coords)

    venues_raw = await nearby_search(centroid_lat, centroid_lng, radius, session.locale)
    ranked = rank_venues(venues_raw, (centroid_lat, centroid_lng), radius)
    top_venues = ranked[:10]

    # Persist centroid + upsert top venues
    session.centroid = _point(centroid_lat, centroid_lng)
    session.search_radius_m = radius

    existing_result = await db.execute(
        select(SelectedVenue).where(SelectedVenue.session_id == session_id)
    )
    existing = {v.place_id: v for v in existing_result.scalars().all()}

    for v in top_venues:
        place_id = v["place_id"]
        lat_v, lng_v = v.get("lat", 0.0), v.get("lng", 0.0)
        loc = _point(lat_v, lng_v) if lat_v and lng_v else None
        if place_id in existing:
            existing[place_id].name = v["name"]
        else:
            db.add(
                SelectedVenue(
                    session_id=session_id,
                    place_id=place_id,
                    name=v["name"],
                    location=loc,
                    votes=0,
                )
            )

    await db.flush()

    # Firebase writes — non-fatal
    await write_centroid(session_id, centroid_lat, centroid_lng)

    return MidpointResponse(
        session_id=session_id,
        centroid=LatLng(lat=centroid_lat, lng=centroid_lng),
        search_radius_m=radius,
        venues=[_venue_out(v) for v in top_venues],
        participant_count=len(participants),
    )


async def vote_venue(db: AsyncSession, session_id: str, request: VoteRequest) -> VoteResponse:
    await _get_active_session(db, session_id)

    p_result = await db.execute(
        select(Participant).where(
            Participant.id == request.participant_id,
            Participant.session_id == session_id,
        )
    )
    if p_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Participant not found in this session")

    v_result = await db.execute(
        select(SelectedVenue).where(
            SelectedVenue.session_id == session_id,
            SelectedVenue.place_id == request.place_id,
        )
    )
    venue = v_result.scalar_one_or_none()

    if venue is None:
        location = None
        if request.venue_lat is not None and request.venue_lng is not None:
            location = _point(request.venue_lat, request.venue_lng)
        venue = SelectedVenue(
            session_id=session_id,
            place_id=request.place_id,
            name=request.venue_name or request.place_id,
            location=location,
            votes=1,
        )
        db.add(venue)
    else:
        venue.votes = (venue.votes or 0) + 1

    await db.flush()
    return VoteResponse(place_id=request.place_id, votes=venue.votes)


async def delete_session(db: AsyncSession, session_id: str) -> None:
    """Soft-delete: mark session as completed (user-initiated, distinct from TTL expiry)."""
    session = await _get_active_session(db, session_id)
    session.status = "completed"
    await db.flush()
    await write_session_status(session_id, "completed")

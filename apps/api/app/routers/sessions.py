from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.models.schemas import (
    CreateSessionRequest,
    JoinResponse,
    JoinSessionRequest,
    MidpointResponse,
    SessionOut,
    UpdateLocationRequest,
    VoteRequest,
    VoteResponse,
)
from app.services import session_service

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])

_404 = {404: {"description": "Session not found"}}
_410 = {410: {"description": "Session expired or completed"}}
_422 = {422: {"description": "Validation error"}}
_429 = {429: {"description": "Rate limit exceeded"}}


@router.post(
    "",
    response_model=SessionOut,
    status_code=201,
    summary="Create a new session",
    description="Creates a new session with an optional locale and participant cap.",
    responses={**_422, **_429},
)
async def create_session(
    request: CreateSessionRequest = CreateSessionRequest(),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    return await session_service.create_session(db, request)


@router.get(
    "/{session_id}",
    response_model=SessionOut,
    summary="Get session details",
    description="Returns current session state including participant count.",
    responses={**_404, **_410, **_429},
)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    return await session_service.get_session(db, session_id)


@router.post(
    "/{session_id}/join",
    response_model=JoinResponse,
    status_code=201,
    summary="Join a session",
    description="Add a participant with a display name and initial location.",
    responses={**_404, 409: {"description": "Session is full"}, **_410, **_422, **_429},
)
async def join_session(
    session_id: str,
    request: JoinSessionRequest,
    db: AsyncSession = Depends(get_db),
) -> JoinResponse:
    return await session_service.join_session(db, session_id, request)


@router.put(
    "/{session_id}/location",
    status_code=204,
    summary="Update participant location",
    description="Push a new GPS coordinate for a participant. Synced to Firebase RTDB.",
    responses={**_404, **_410, **_422, **_429},
)
async def update_location(
    session_id: str,
    request: UpdateLocationRequest,
    db: AsyncSession = Depends(get_db),
) -> None:
    await session_service.update_location(db, session_id, request)


@router.get(
    "/{session_id}/midpoint",
    response_model=MidpointResponse,
    summary="Compute geodesic centroid and ranked venues",
    description=(
        "Returns the WGS84 centroid of all participant locations and a ranked list of "
        "nearby POIs. Requires ≥2 participants with locations set."
    ),
    responses={
        **_404,
        **_410,
        422: {"description": "Fewer than 2 participants with locations"},
        **_429,
    },
)
async def get_midpoint(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> MidpointResponse:
    return await session_service.get_midpoint(db, session_id)


@router.post(
    "/{session_id}/vote",
    response_model=VoteResponse,
    summary="Vote for a venue",
    description="Cast a vote for a venue. Creates the venue record if it does not exist.",
    responses={**_404, **_410, **_422, **_429},
)
async def vote_venue(
    session_id: str,
    request: VoteRequest,
    db: AsyncSession = Depends(get_db),
) -> VoteResponse:
    return await session_service.vote_venue(db, session_id, request)


@router.delete(
    "/{session_id}",
    status_code=204,
    summary="End a session",
    description="Marks the session as completed and syncs status to Firebase RTDB.",
    responses={**_404, **_410, **_429},
)
async def delete_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> None:
    await session_service.delete_session(db, session_id)

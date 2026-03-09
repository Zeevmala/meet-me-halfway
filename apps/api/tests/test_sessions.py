"""
Session API tests — two layers:

1. HTTP layer  — httpx.AsyncClient + ASGITransport, service patched with AsyncMock.
   Fast, tests routing / response shape / status codes.

2. Service layer — FakeDB + direct service calls.
   Tests business logic: DB interactions, Firebase calls, error guards.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException
from httpx import ASGITransport

from app.dependencies import get_db
from app.main import create_app

# Valid UUID used for HTTP-layer tests (must pass UUIDValidationMiddleware)
TEST_SESSION_UUID = "550e8400-e29b-41d4-a716-446655440000"
from app.models.schemas import (
    CreateSessionRequest,
    JoinResponse,
    JoinSessionRequest,
    LatLng,
    MidpointResponse,
    SessionOut,
    UpdateLocationRequest,
    VoteRequest,
    VoteResponse,
)
from app.services import session_service

# ═══════════════════════════════════════════════════════════════════════════════
# Test doubles
# ═══════════════════════════════════════════════════════════════════════════════


class _FakeScalars:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self) -> list:
        return self._rows


class FakeResult:
    """Simulates the return value of AsyncSession.execute()."""

    def __init__(self, rows: list) -> None:
        self._rows = rows

    def scalar_one_or_none(self) -> Any | None:
        return self._rows[0] if self._rows else None

    def scalar_one(self) -> Any:
        return self._rows[0]

    def scalars(self) -> _FakeScalars:
        return _FakeScalars(self._rows)


class FakeDB:
    """
    Minimal AsyncSession stand-in.
    Pass a list of FakeResult objects; each execute() call consumes the next one.
    """

    def __init__(self, responses: list[FakeResult]) -> None:
        self._queue = list(responses)
        self.added: list[Any] = []
        self.flush_count = 0

    async def execute(self, _stmt: Any) -> FakeResult:
        return self._queue.pop(0)

    async def flush(self) -> None:
        self.flush_count += 1

    def add(self, obj: Any) -> None:
        self.added.append(obj)


@dataclass
class MockSession:
    id: str = "test-session-id"
    status: str = "active"
    max_participants: int = 5
    locale: str = "en"
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime = field(default_factory=lambda: datetime.now(UTC) + timedelta(hours=4))
    centroid: Any = None
    search_radius_m: float | None = None


@dataclass
class MockParticipant:
    id: str = "p-001"
    session_id: str = "test-session-id"
    display_name: str = "Ze'ev"
    location: Any = None
    phone_hash: str | None = None
    updated_at: datetime | None = None


@dataclass
class MockVenue:
    id: str = "v-001"
    session_id: str = "test-session-id"
    place_id: str = "ChIJabc"
    name: str = "Café"
    location: Any = None
    votes: int = 0
    selected: bool = False


def _make_session_out(**kwargs: Any) -> SessionOut:
    defaults: dict[str, Any] = dict(
        session_id=TEST_SESSION_UUID,
        status="active",
        locale="en",
        created_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=4),
        participant_count=0,
        max_participants=5,
    )
    return SessionOut(**(defaults | kwargs))


def _make_geometry_mock(lat: float, lng: float) -> MagicMock:
    """Return a mock geometry whose to_shape() resolves to (lat, lng)."""
    g = MagicMock()
    shape = MagicMock()
    shape.y = lat  # shapely: y = latitude
    shape.x = lng  # shapely: x = longitude
    g._shape = shape
    return g


# ═══════════════════════════════════════════════════════════════════════════════
# Fixtures
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.fixture
def app():
    return create_app()


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def mock_db():
    db = AsyncMock()
    db.flush = AsyncMock()
    return db


# ═══════════════════════════════════════════════════════════════════════════════
# 1 — Health
# ═══════════════════════════════════════════════════════════════════════════════


async def test_health_check(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


# ═══════════════════════════════════════════════════════════════════════════════
# 2 — Route registration (no DB)
# ═══════════════════════════════════════════════════════════════════════════════


async def test_session_routes_registered(client):
    """Routes must not return 404 regardless of DB availability."""
    for method, path in [
        ("POST", "/api/v1/sessions"),
        ("GET", "/api/v1/sessions/x"),
        ("POST", "/api/v1/sessions/x/join"),
        ("PUT", "/api/v1/sessions/x/location"),
        ("GET", "/api/v1/sessions/x/midpoint"),
        ("POST", "/api/v1/sessions/x/vote"),
        ("DELETE", "/api/v1/sessions/x"),
    ]:
        try:
            resp = await client.request(method, path, json={})
            assert resp.status_code != 404, f"{method} {path} → 404"
        except Exception as exc:
            assert "404" not in str(exc), f"{method} {path} raised 404 error"


# ═══════════════════════════════════════════════════════════════════════════════
# 3 — HTTP layer (service patched)
# ═══════════════════════════════════════════════════════════════════════════════


async def test_http_create_session(app, mock_db):
    session_out = _make_session_out(locale="he")
    with patch(
        "app.services.session_service.create_session", new=AsyncMock(return_value=session_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/v1/sessions", json={"locale": "he", "max_participants": 3})
    app.dependency_overrides.clear()
    assert resp.status_code == 201
    assert resp.json()["locale"] == "he"


async def test_http_create_session_no_body(app, mock_db):
    session_out = _make_session_out()
    with patch(
        "app.services.session_service.create_session", new=AsyncMock(return_value=session_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/v1/sessions")
    app.dependency_overrides.clear()
    assert resp.status_code == 201


async def test_http_get_session(app, mock_db):
    session_out = _make_session_out(participant_count=2)
    with patch(
        "app.services.session_service.get_session", new=AsyncMock(return_value=session_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{TEST_SESSION_UUID}")
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    assert resp.json()["participant_count"] == 2


async def test_http_join_session(app, mock_db):
    join_out = JoinResponse(participant_id="p-001", session_id=TEST_SESSION_UUID)
    with patch("app.services.session_service.join_session", new=AsyncMock(return_value=join_out)):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                f"/api/v1/sessions/{TEST_SESSION_UUID}/join",
                json={"display_name": "Ze'ev", "location": {"lat": 32.08, "lng": 34.78}},
            )
    app.dependency_overrides.clear()
    assert resp.status_code == 201
    assert resp.json()["participant_id"] == "p-001"


async def test_http_update_location(app, mock_db):
    with patch("app.services.session_service.update_location", new=AsyncMock(return_value=None)):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.put(
                f"/api/v1/sessions/{TEST_SESSION_UUID}/location",
                json={"participant_id": "p-001", "location": {"lat": 32.08, "lng": 34.78}},
            )
    app.dependency_overrides.clear()
    assert resp.status_code == 204


async def test_http_get_midpoint(app, mock_db):
    midpoint_out = MidpointResponse(
        session_id=TEST_SESSION_UUID,
        centroid=LatLng(lat=31.93, lng=34.99),
        search_radius_m=1200.0,
        venues=[],
        participants=[],
        participant_count=2,
    )
    with patch(
        "app.services.session_service.get_midpoint", new=AsyncMock(return_value=midpoint_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{TEST_SESSION_UUID}/midpoint")
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    data = resp.json()
    assert data["centroid"]["lat"] == pytest.approx(31.93)
    assert data["search_radius_m"] == 1200.0


async def test_http_vote_venue(app, mock_db):
    vote_out = VoteResponse(place_id="ChIJabc123", votes=3)
    with patch("app.services.session_service.vote_venue", new=AsyncMock(return_value=vote_out)):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post(
                f"/api/v1/sessions/{TEST_SESSION_UUID}/vote",
                json={"participant_id": "p-001", "place_id": "ChIJabc123"},
            )
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    assert resp.json()["votes"] == 3


async def test_http_delete_session(app, mock_db):
    with patch("app.services.session_service.delete_session", new=AsyncMock(return_value=None)):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.delete(f"/api/v1/sessions/{TEST_SESSION_UUID}")
    app.dependency_overrides.clear()
    assert resp.status_code == 204


# ═══════════════════════════════════════════════════════════════════════════════
# 4 — Service layer: create_session
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_create_session_inserts_row():
    db = FakeDB(responses=[])
    result = await session_service.create_session(
        db, CreateSessionRequest(locale="he", max_participants=3)
    )
    assert result.locale == "he"
    assert result.status == "active"
    assert result.max_participants == 3
    assert len(db.added) == 1
    assert db.flush_count == 1


async def test_service_create_session_default_locale():
    db = FakeDB(responses=[])
    result = await session_service.create_session(db, CreateSessionRequest())
    assert result.locale == "en"
    assert result.participant_count == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 5 — Service layer: get_session
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_get_session_returns_count():
    session = MockSession()
    db = FakeDB(
        responses=[
            FakeResult([session]),  # _get_active_session
            FakeResult([3]),  # count query
        ]
    )
    result = await session_service.get_session(db, "test-session-id")
    assert result.participant_count == 3
    assert result.session_id == "test-session-id"


async def test_service_get_session_not_found():
    db = FakeDB(responses=[FakeResult([])])
    with pytest.raises(Exception) as exc_info:
        await session_service.get_session(db, "missing-id")
    assert "404" in str(exc_info.value.status_code)


async def test_service_get_session_expired_raises_410():
    session = MockSession(expires_at=datetime.now(UTC) - timedelta(hours=1))
    db = FakeDB(responses=[FakeResult([session])])
    with pytest.raises(Exception) as exc_info:
        await session_service.get_session(db, "test-session-id")
    assert exc_info.value.status_code == 410


async def test_service_get_session_completed_raises_410():
    session = MockSession(status="completed")
    db = FakeDB(responses=[FakeResult([session])])
    with pytest.raises(Exception) as exc_info:
        await session_service.get_session(db, "test-session-id")
    assert exc_info.value.status_code == 410


# ═══════════════════════════════════════════════════════════════════════════════
# 6 — Service layer: join_session
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_join_session_adds_participant():
    session = MockSession(max_participants=5)
    db = FakeDB(
        responses=[
            FakeResult([session]),  # _get_active_session
            FakeResult([2]),  # participant count
        ]
    )
    req = JoinSessionRequest(display_name="Ze'ev", location=LatLng(lat=32.08, lng=34.78))

    with patch("app.services.session_service.write_participant_location", new=AsyncMock()):
        result = await session_service.join_session(db, "test-session-id", req)

    assert isinstance(result, JoinResponse)
    assert result.session_id == "test-session-id"
    assert len(db.added) == 1  # Participant inserted
    assert db.flush_count == 1


async def test_service_join_session_full_raises_409():
    session = MockSession(max_participants=3)
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([3]),  # already at max
        ]
    )
    req = JoinSessionRequest(display_name="Late", location=LatLng(lat=32.0, lng=34.0))
    with pytest.raises(Exception) as exc_info:
        await session_service.join_session(db, "test-session-id", req)
    assert exc_info.value.status_code == 409


async def test_service_join_session_syncs_firebase():
    session = MockSession()
    db = FakeDB(responses=[FakeResult([session]), FakeResult([0])])
    req = JoinSessionRequest(display_name="Moshe", location=LatLng(lat=32.08, lng=34.78))

    firebase_mock = AsyncMock()
    with patch("app.services.session_service.write_participant_location", firebase_mock):
        await session_service.join_session(db, "test-session-id", req)

    firebase_mock.assert_awaited_once()
    args = firebase_mock.call_args
    assert args[0][0] == "test-session-id"  # session_id
    assert args[0][2] == "Moshe"  # display_name
    assert args[0][3] == pytest.approx(32.08)  # lat
    assert args[0][4] == pytest.approx(34.78)  # lng


# ═══════════════════════════════════════════════════════════════════════════════
# 7 — Service layer: update_location
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_update_location_mutates_geometry():
    session = MockSession()
    participant = MockParticipant()
    db = FakeDB(
        responses=[
            FakeResult([session]),  # _get_active_session
            FakeResult([participant]),  # participant lookup
        ]
    )
    req = UpdateLocationRequest(participant_id="p-001", location=LatLng(lat=31.77, lng=35.21))

    with patch("app.services.session_service.write_participant_location", new=AsyncMock()):
        await session_service.update_location(db, "test-session-id", req)

    assert db.flush_count == 1
    # location was updated on the participant object
    assert participant.location is not None
    assert participant.updated_at is not None


async def test_service_update_location_wrong_participant_raises_404():
    session = MockSession()
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([]),  # participant not found
        ]
    )
    req = UpdateLocationRequest(participant_id="bad-id", location=LatLng(lat=32.0, lng=34.0))
    with pytest.raises(Exception) as exc_info:
        await session_service.update_location(db, "test-session-id", req)
    assert exc_info.value.status_code == 404


async def test_service_update_location_syncs_firebase():
    session = MockSession()
    participant = MockParticipant(display_name="Rivka")
    db = FakeDB(responses=[FakeResult([session]), FakeResult([participant])])
    req = UpdateLocationRequest(participant_id="p-001", location=LatLng(lat=31.5, lng=34.9))

    firebase_mock = AsyncMock()
    with patch("app.services.session_service.write_participant_location", firebase_mock):
        await session_service.update_location(db, "test-session-id", req)

    firebase_mock.assert_awaited_once()
    args = firebase_mock.call_args[0]
    assert args[2] == "Rivka"
    assert args[3] == pytest.approx(31.5)
    assert args[4] == pytest.approx(34.9)


# ═══════════════════════════════════════════════════════════════════════════════
# 8 — Service layer: get_midpoint
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_get_midpoint_too_few_participants_raises_422():
    session = MockSession()
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([MockParticipant()]),  # only 1 participant
        ]
    )
    with pytest.raises(Exception) as exc_info:
        await session_service.get_midpoint(db, "test-session-id")
    assert exc_info.value.status_code == 422


async def test_service_get_midpoint_zero_participants_raises_422():
    session = MockSession()
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([]),  # no participants
        ]
    )
    with pytest.raises(Exception) as exc_info:
        await session_service.get_midpoint(db, "test-session-id")
    assert exc_info.value.status_code == 422


async def test_service_get_midpoint_computes_centroid():
    """Full pipeline with 2 participants: Tel Aviv + Jerusalem → known centroid."""
    session = MockSession(locale="en")
    p1 = MockParticipant(id="p-001", location=_make_geometry_mock(32.0853, 34.7818))
    p2 = MockParticipant(id="p-002", location=_make_geometry_mock(31.7683, 35.2137))

    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([p1, p2]),  # participants with locations
            FakeResult([]),  # existing selected_venues
        ]
    )

    def fake_to_shape(geom: Any) -> Any:
        return geom._shape

    with (
        patch("app.services.session_service.to_shape", side_effect=fake_to_shape),
        patch("app.services.session_service.nearby_search", new=AsyncMock(return_value=[])),
        patch("app.services.session_service.write_centroid", new=AsyncMock()),
    ):
        result = await session_service.get_midpoint(db, "test-session-id")

    assert isinstance(result, MidpointResponse)
    assert abs(result.centroid.lat - 31.927) < 0.01
    assert abs(result.centroid.lng - 34.998) < 0.01
    assert result.participant_count == 2
    assert result.session_id == "test-session-id"


async def test_service_get_midpoint_writes_centroid_to_firebase():
    session = MockSession()
    p1 = MockParticipant(id="p-001", location=_make_geometry_mock(32.0853, 34.7818))
    p2 = MockParticipant(id="p-002", location=_make_geometry_mock(31.7683, 35.2137))
    db = FakeDB(responses=[FakeResult([session]), FakeResult([p1, p2]), FakeResult([])])

    def fake_to_shape(geom: Any) -> Any:
        return geom._shape

    firebase_mock = AsyncMock()
    with (
        patch("app.services.session_service.to_shape", side_effect=fake_to_shape),
        patch("app.services.session_service.nearby_search", new=AsyncMock(return_value=[])),
        patch("app.services.session_service.write_centroid", firebase_mock),
    ):
        await session_service.get_midpoint(db, "test-session-id")

    firebase_mock.assert_awaited_once()
    args = firebase_mock.call_args[0]
    assert args[0] == "test-session-id"
    assert abs(args[1] - 31.927) < 0.01  # lat
    assert abs(args[2] - 34.998) < 0.01  # lng


async def test_service_get_midpoint_upserts_venues():
    session = MockSession()
    p1 = MockParticipant(id="p-001", location=_make_geometry_mock(32.08, 34.78))
    p2 = MockParticipant(id="p-002", location=_make_geometry_mock(31.77, 35.21))
    db = FakeDB(responses=[FakeResult([session]), FakeResult([p1, p2]), FakeResult([])])

    fake_venues = [
        {
            "place_id": "ChIJ001",
            "name": "Café A",
            "lat": 31.93,
            "lng": 34.998,
            "rating": 4.5,
            "user_ratings_total": 100,
            "open_now": True,
            "types": ["cafe"],
            "vicinity": "1 St",
        }
    ]

    def fake_to_shape(geom: Any) -> Any:
        return geom._shape

    with (
        patch("app.services.session_service.to_shape", side_effect=fake_to_shape),
        patch(
            "app.services.session_service.nearby_search", new=AsyncMock(return_value=fake_venues)
        ),
        patch("app.services.session_service.write_centroid", new=AsyncMock()),
    ):
        result = await session_service.get_midpoint(db, "test-session-id")

    # One SelectedVenue should have been added
    assert len(db.added) == 1
    assert db.added[0].place_id == "ChIJ001"
    assert len(result.venues) == 1
    assert result.venues[0].name == "Café A"


# ═══════════════════════════════════════════════════════════════════════════════
# 9 — Service layer: vote_venue
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_vote_creates_venue_if_missing():
    session = MockSession()
    participant = MockParticipant()
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([participant]),  # participant lookup
            FakeResult([]),  # venue not found → create
        ]
    )
    req = VoteRequest(participant_id="p-001", place_id="ChIJnew", venue_name="New Place")
    result = await session_service.vote_venue(db, "test-session-id", req)
    assert result.place_id == "ChIJnew"
    assert result.votes == 1
    assert len(db.added) == 1


async def test_service_vote_increments_existing_venue():
    session = MockSession()
    participant = MockParticipant()
    existing_venue = MockVenue(place_id="ChIJexist", votes=2)
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([participant]),
            FakeResult([existing_venue]),
        ]
    )
    req = VoteRequest(participant_id="p-001", place_id="ChIJexist")
    result = await session_service.vote_venue(db, "test-session-id", req)
    assert result.votes == 3
    assert existing_venue.votes == 3


async def test_service_vote_unknown_participant_raises_404():
    session = MockSession()
    db = FakeDB(
        responses=[
            FakeResult([session]),
            FakeResult([]),  # participant not found
        ]
    )
    req = VoteRequest(participant_id="nobody", place_id="ChIJabc")
    with pytest.raises(Exception) as exc_info:
        await session_service.vote_venue(db, "test-session-id", req)
    assert exc_info.value.status_code == 404


# ═══════════════════════════════════════════════════════════════════════════════
# 10 — Service layer: delete_session
# ═══════════════════════════════════════════════════════════════════════════════


async def test_service_delete_sets_status_completed():
    session = MockSession()
    db = FakeDB(responses=[FakeResult([session])])
    with patch("app.services.session_service.write_session_status", new=AsyncMock()):
        await session_service.delete_session(db, "test-session-id")
    assert session.status == "completed"
    assert db.flush_count == 1


async def test_service_delete_syncs_firebase():
    session = MockSession()
    db = FakeDB(responses=[FakeResult([session])])
    firebase_mock = AsyncMock()
    with patch("app.services.session_service.write_session_status", firebase_mock):
        await session_service.delete_session(db, "test-session-id")
    firebase_mock.assert_awaited_once_with("test-session-id", "completed")


async def test_service_delete_already_completed_raises_410():
    session = MockSession(status="completed")
    db = FakeDB(responses=[FakeResult([session])])
    with pytest.raises(Exception) as exc_info:
        await session_service.delete_session(db, "test-session-id")
    assert exc_info.value.status_code == 410


# ═══════════════════════════════════════════════════════════════════════════════
# 11 — Contract / validation tests
# ═══════════════════════════════════════════════════════════════════════════════


async def test_contract_session_out_keys(app, mock_db):
    session_out = _make_session_out()
    expected_keys = {
        "session_id",
        "status",
        "locale",
        "created_at",
        "expires_at",
        "participant_count",
        "max_participants",
    }
    with patch(
        "app.services.session_service.get_session", new=AsyncMock(return_value=session_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{session_out.session_id}")
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    assert set(resp.json().keys()) == expected_keys


async def test_contract_midpoint_response_keys(app, mock_db):
    midpoint_out = MidpointResponse(
        session_id=TEST_SESSION_UUID,
        centroid=LatLng(lat=31.93, lng=34.99),
        search_radius_m=1200.0,
        venues=[],
        participants=[],
        participant_count=2,
    )
    with patch(
        "app.services.session_service.get_midpoint", new=AsyncMock(return_value=midpoint_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{TEST_SESSION_UUID}/midpoint")
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    data = resp.json()
    assert set(data.keys()) == {
        "session_id",
        "centroid",
        "search_radius_m",
        "venues",
        "participants",
        "participant_count",
    }
    assert set(data["centroid"].keys()) == {"lat", "lng"}


async def test_contract_venue_out_keys(app, mock_db):
    from app.models.schemas import VenueOut

    venue = VenueOut(
        place_id="ChIJabc",
        name="Café Midpoint",
        lat=31.93,
        lng=34.99,
        rating=4.5,
        user_ratings_total=200,
        open_now=True,
        distance_to_centroid_m=320.0,
        score=0.82,
        types=["cafe"],
        vicinity="1 St",
    )
    midpoint_out = MidpointResponse(
        session_id=TEST_SESSION_UUID,
        centroid=LatLng(lat=31.93, lng=34.99),
        search_radius_m=1200.0,
        venues=[venue],
        participants=[],
        participant_count=2,
    )
    expected_venue_keys = {
        "place_id",
        "name",
        "lat",
        "lng",
        "rating",
        "user_ratings_total",
        "open_now",
        "distance_to_centroid_m",
        "score",
        "types",
        "vicinity",
    }
    with patch(
        "app.services.session_service.get_midpoint", new=AsyncMock(return_value=midpoint_out)
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{TEST_SESSION_UUID}/midpoint")
    app.dependency_overrides.clear()
    assert resp.status_code == 200
    venues = resp.json()["venues"]
    assert len(venues) == 1
    assert set(venues[0].keys()) == expected_venue_keys


async def test_uuid_validation_rejects_malformed(client):
    resp = await client.get("/api/v1/sessions/not-a-uuid")
    assert resp.status_code == 422
    assert "UUID" in resp.json()["detail"]


async def test_uuid_validation_accepts_valid_uuid(app, mock_db):
    valid_uuid = "550e8400-e29b-41d4-a716-446655440000"
    with patch(
        "app.services.session_service.get_session",
        new=AsyncMock(side_effect=HTTPException(status_code=404, detail="not found")),
    ):
        app.dependency_overrides[get_db] = lambda: mock_db
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.get(f"/api/v1/sessions/{valid_uuid}")
    app.dependency_overrides.clear()
    # 422 would mean UUID validation blocked it; 404 means it passed validation
    assert resp.status_code == 404

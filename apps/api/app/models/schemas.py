from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# ── Primitives ──────────────────────────────────────────────────────────────


class LatLng(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


# ── Request schemas ──────────────────────────────────────────────────────────


class CreateSessionRequest(BaseModel):
    locale: str = Field(default="en", examples=["en", "he", "ar"])
    max_participants: int = Field(default=5, ge=2, le=5, examples=[3, 5])


class JoinSessionRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=100)
    location: LatLng
    phone_hash: str | None = Field(default=None, max_length=64)


class UpdateLocationRequest(BaseModel):
    participant_id: str
    location: LatLng


class VoteRequest(BaseModel):
    participant_id: str
    place_id: str
    venue_name: str | None = None
    venue_lat: float | None = None
    venue_lng: float | None = None


# ── Response schemas ─────────────────────────────────────────────────────────


class JoinResponse(BaseModel):
    participant_id: str
    session_id: str


class SessionOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "session_id": "550e8400-e29b-41d4-a716-446655440000",
                "status": "active",
                "locale": "en",
                "created_at": "2024-01-01T12:00:00Z",
                "expires_at": "2024-01-01T16:00:00Z",
                "participant_count": 2,
                "max_participants": 5,
            }
        }
    )

    session_id: str
    status: str
    locale: str
    created_at: datetime
    expires_at: datetime
    participant_count: int
    max_participants: int


class VenueOut(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "place_id": "ChIJabc123",
                "name": "Café Midpoint",
                "lat": 31.93,
                "lng": 34.99,
                "rating": 4.5,
                "user_ratings_total": 200,
                "open_now": True,
                "distance_to_centroid_m": 320.0,
                "score": 0.82,
                "types": ["cafe", "food"],
                "vicinity": "1 Example Street",
            }
        }
    )

    place_id: str
    name: str
    lat: float
    lng: float
    rating: float | None = None
    user_ratings_total: int | None = None
    open_now: bool | None = None
    distance_to_centroid_m: float
    score: float
    types: list[str] = []
    vicinity: str | None = None


class MidpointResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "session_id": "550e8400-e29b-41d4-a716-446655440000",
                "centroid": {"lat": 31.93, "lng": 34.99},
                "search_radius_m": 1200.0,
                "venues": [],
                "participant_count": 2,
            }
        }
    )

    session_id: str
    centroid: LatLng
    search_radius_m: float
    venues: list[VenueOut]
    participant_count: int


class VoteResponse(BaseModel):
    place_id: str
    votes: int

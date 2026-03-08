from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geometry
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    SmallInteger,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.ext.asyncio import AsyncAttrs, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.config import settings


class Base(AsyncAttrs, DeclarativeBase):
    pass


engine = create_async_engine(settings.DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, expire_on_commit=False)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    centroid: Mapped[object | None] = mapped_column(Geometry("POINT", srid=4326), nullable=True)
    search_radius_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    locale: Mapped[str] = mapped_column(String(10), nullable=False, default="en")
    max_participants: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=5)

    participants: Mapped[list[Participant]] = relationship(
        "Participant", back_populates="session", lazy="select"
    )
    selected_venues: Mapped[list[SelectedVenue]] = relationship(
        "SelectedVenue", back_populates="session", lazy="select"
    )


class Participant(Base):
    __tablename__ = "participants"
    __table_args__ = (UniqueConstraint("session_id", "phone_hash", name="uq_participant_phone"),)

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    phone_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    location: Mapped[object | None] = mapped_column(Geometry("POINT", srid=4326), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    session: Mapped[Session] = relationship("Session", back_populates="participants")


class SelectedVenue(Base):
    __tablename__ = "selected_venues"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    place_id: Mapped[str] = mapped_column(String(300), nullable=False)
    name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    location: Mapped[object | None] = mapped_column(Geometry("POINT", srid=4326), nullable=True)
    votes: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    selected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    session: Mapped[Session] = relationship("Session", back_populates="selected_venues")

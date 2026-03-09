"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-03-07 00:00:00.000000
"""

import sqlalchemy as sa
from geoalchemy2 import Geometry

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("centroid", Geometry("POINT", srid=4326), nullable=True),
        sa.Column("search_radius_m", sa.Float, nullable=True),
        sa.Column("locale", sa.String(10), nullable=False, server_default="en"),
        sa.Column("max_participants", sa.SmallInteger, nullable=False, server_default="5"),
    )

    op.create_table(
        "participants",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("phone_hash", sa.String(64), nullable=True),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("location", Geometry("POINT", srid=4326), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("session_id", "phone_hash", name="uq_participant_phone"),
    )

    op.create_table(
        "selected_venues",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("place_id", sa.String(300), nullable=False),
        sa.Column("name", sa.String(300), nullable=True),
        sa.Column("location", Geometry("POINT", srid=4326), nullable=True),
        sa.Column("votes", sa.SmallInteger, nullable=False, server_default="0"),
        sa.Column("selected", sa.Boolean, nullable=False, server_default="false"),
    )

    # Indexes
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_active"
        " ON sessions (expires_at) WHERE status = 'active'"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_participants_session" " ON participants (session_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_participants_location"
        " ON participants USING GIST (location)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_venues_session" " ON selected_venues (session_id)")


def downgrade() -> None:
    op.drop_table("selected_venues")
    op.drop_table("participants")
    op.drop_table("sessions")

"""phone_session_map table and phone_hash index

Revision ID: 0002
Revises: 0001
Create Date: 2026-03-12 00:00:00.000000
"""

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "phone_session_map",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("phone_hash", sa.String(64), nullable=False),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
        ),
        sa.UniqueConstraint("phone_hash", "session_id", name="uq_phone_session"),
    )
    op.create_index("idx_phone_session_map_phone", "phone_session_map", ["phone_hash"])
    # Index on existing participants.phone_hash for WhatsApp location lookups
    op.create_index(
        "idx_participants_phone_hash",
        "participants",
        ["phone_hash"],
        postgresql_where=sa.text("phone_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_participants_phone_hash", table_name="participants")
    op.drop_index("idx_phone_session_map_phone", table_name="phone_session_map")
    op.drop_table("phone_session_map")

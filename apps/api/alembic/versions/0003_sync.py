"""sync: processed commands for idempotent push

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "processed_commands",
        sa.Column("id", sa.Uuid(), primary_key=True),  # the client's command id
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("result", postgresql.JSONB()),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status in ('applied','rejected')", name="processed_status_known"),
    )
    op.create_index(
        "ix_processed_commands_device_received", "processed_commands", ["device_id", "received_at"]
    )


def downgrade() -> None:
    op.drop_table("processed_commands")

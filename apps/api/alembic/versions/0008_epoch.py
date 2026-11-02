"""sync epoch: a number that changes when the server is restored from a backup

Revision ID: 0008
Revises: 0007

A device remembers how far it has read (`cursor`). If the server is restored from an older backup,
that cursor can be ahead of rows that no longer exist, and rows written after the restore can get
numbers the device believes it has already read. The epoch lets the device notice: when it changes,
the device drops what it had read from the server and reads everything again.
"""

import sqlalchemy as sa

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sync_clock",
        sa.Column("epoch", sa.Uuid(), nullable=False, server_default=sa.text("gen_random_uuid()")),
    )


def downgrade() -> None:
    op.drop_column("sync_clock", "epoch")

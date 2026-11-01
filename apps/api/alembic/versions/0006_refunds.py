"""refunds: money given back to a customer, kept in the payments table with a kind

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "payments", sa.Column("kind", sa.String(), nullable=False, server_default="payment")
    )
    op.create_check_constraint("payment_kind_known", "payments", "kind in ('payment','refund')")


def downgrade() -> None:
    op.drop_constraint("payment_kind_known", "payments", type_="check")
    op.drop_column("payments", "kind")

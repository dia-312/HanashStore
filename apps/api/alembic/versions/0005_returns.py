"""returns: what a customer gives back from an invoice, and the lines of each return

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "returns",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("number", sa.String(), nullable=False, unique=True),
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("total", sa.BigInteger(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("total >= 0", name="return_total_nonnegative"),
    )
    op.create_table(
        "return_lines",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("return_id", sa.Uuid(), sa.ForeignKey("returns.id"), nullable=False),
        sa.Column("invoice_line_id", sa.Uuid(), sa.ForeignKey("invoice_lines.id"), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("disposition", sa.String(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        # Lines never change, so this is the return's change_seq at creation: it is what lets a
        # device pull them like every other table.
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("qty > 0", name="return_line_qty_positive"),
        sa.CheckConstraint("amount >= 0", name="return_line_amount_nonnegative"),
        sa.CheckConstraint(
            "disposition in ('restock','damaged')", name="return_line_disposition_known"
        ),
    )
    op.create_index("ix_returns_customer", "returns", ["customer_id"])
    op.create_index("ix_returns_invoice", "returns", ["invoice_id"])
    op.create_index("ix_return_lines_return", "return_lines", ["return_id"])
    op.create_index("ix_return_lines_invoice_line", "return_lines", ["invoice_line_id"])
    for table in ("returns", "return_lines"):
        op.create_index(f"ix_{table}_change_seq", table, ["change_seq"])


def downgrade() -> None:
    for table in ("return_lines", "returns"):
        op.drop_table(table)

"""sales: customers, invoices, invoice lines, payments

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def _ts(name: str, nullable: bool = False) -> sa.Column[sa.DateTime]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "customers",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("shop_name", sa.String()),
        sa.Column("phone", sa.String()),
        sa.Column("area", sa.String()),
        sa.Column("address", sa.String()),
        sa.Column("notes", sa.Text()),
        # Positive = the customer already owed this much when he was first added (agorot).
        sa.Column("opening_balance", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        _ts("created_at"),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "invoices",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("number", sa.String(), nullable=False, unique=True),
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("subtotal", sa.BigInteger(), nullable=False),
        sa.Column("discount", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("total", sa.BigInteger(), nullable=False),
        sa.Column("note", sa.Text()),
        _ts("issued_at"),
        _ts("delivered_at", nullable=True),
        _ts("cancelled_at", nullable=True),
        sa.Column("cancel_reason", sa.Text()),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.id"), nullable=False),
        _ts("created_at"),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("status in ('confirmed','cancelled')", name="invoice_status_known"),
        sa.CheckConstraint(
            "discount >= 0 and discount <= subtotal and total = subtotal - discount",
            name="invoice_totals_consistent",
        ),
    )
    op.create_table(
        "invoice_lines",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("invoice_id", sa.Uuid(), sa.ForeignKey("invoices.id"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), sa.ForeignKey("product_variants.id"), nullable=False),
        # Names as they were at the time of the sale (SPEC section 6).
        sa.Column("product_name", sa.String(), nullable=False),
        sa.Column("variant_label", sa.String(), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("unit_price", sa.BigInteger(), nullable=False),
        sa.Column("line_total", sa.BigInteger(), nullable=False),
        sa.Column("discount_share", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        # Lines never change, so this is the invoice's change_seq at creation: it is what lets a
        # device pull them like every other table.
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("qty > 0", name="invoice_line_qty_positive"),
        sa.CheckConstraint("unit_price >= 0", name="invoice_line_price_nonnegative"),
    )
    op.create_table(
        "payments",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("number", sa.String(), nullable=False, unique=True),
        sa.Column("customer_id", sa.Uuid(), sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("invoice_id", sa.Uuid(), sa.ForeignKey("invoices.id")),
        sa.Column("method", sa.String(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        _ts("paid_at"),
        sa.Column("note", sa.Text()),
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
        _ts("voided_at", nullable=True),
        sa.Column("void_reason", sa.Text()),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.id"), nullable=False),
        _ts("created_at"),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("method in ('cash','transfer','cheque')", name="payment_method_known"),
        sa.CheckConstraint("amount > 0", name="payment_amount_positive"),
        sa.CheckConstraint("status in ('active','voided')", name="payment_status_known"),
    )

    op.create_index("ix_invoices_customer_issued", "invoices", ["customer_id", "issued_at"])
    op.create_index("ix_payments_customer_paid", "payments", ["customer_id", "paid_at"])
    op.create_index("ix_payments_invoice", "payments", ["invoice_id"])
    op.create_index("ix_invoice_lines_invoice", "invoice_lines", ["invoice_id"])
    op.create_index("ix_invoice_lines_variant", "invoice_lines", ["variant_id"])
    for table in ("customers", "invoices", "invoice_lines", "payments"):
        op.create_index(f"ix_{table}_change_seq", table, ["change_seq"])
    op.execute(
        "CREATE INDEX ix_customers_search_trgm ON customers USING gin (search_text gin_trgm_ops)"
    )


def downgrade() -> None:
    for table in ("payments", "invoice_lines", "invoices", "customers"):
        op.drop_table(table)

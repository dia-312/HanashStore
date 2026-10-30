"""catalog and stock: categories, products, variants, images, stock movements, audit log

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def _ts(name: str, nullable: bool = False) -> sa.Column[sa.DateTime]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE SEQUENCE sku_seq")

    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "products",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("category_id", sa.Uuid(), sa.ForeignKey("categories.id"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        _ts("created_at"),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "product_variants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("sku", sa.String(), nullable=False, unique=True),
        sa.Column("color", sa.String()),
        sa.Column("size", sa.String()),
        sa.Column("price", sa.BigInteger(), nullable=False),
        sa.Column("min_stock", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stock_qty", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        _ts("created_at"),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("price >= 0", name="variant_price_nonnegative"),
        sa.CheckConstraint("min_stock >= 0", name="variant_min_stock_nonnegative"),
        sa.UniqueConstraint(
            "product_id",
            "color",
            "size",
            name="uq_variant_product_color_size",
            postgresql_nulls_not_distinct=True,
        ),
    )
    op.create_table(
        "product_images",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("products.id"), nullable=False),
        sa.Column("variant_id", sa.Uuid(), sa.ForeignKey("product_variants.id")),
        sa.Column("thumb_url", sa.String(), nullable=False),
        sa.Column("full_url", sa.String(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        _ts("deleted_at", nullable=True),
        _ts("updated_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "stock_movements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("variant_id", sa.Uuid(), sa.ForeignKey("product_variants.id"), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("ref_type", sa.String()),
        sa.Column("ref_id", sa.Uuid()),
        sa.Column("note", sa.Text()),
        sa.Column("device_id", sa.Uuid(), sa.ForeignKey("devices.id")),
        _ts("created_at"),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("qty <> 0", name="movement_qty_nonzero"),
        sa.CheckConstraint(
            "type in ('opening','purchase','sale','sale_cancel','return','damage','adjustment')",
            name="movement_type_known",
        ),
    )
    op.create_table(
        "audit_log",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("entity", sa.String(), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("before", postgresql.JSONB()),
        sa.Column("after", postgresql.JSONB()),
        sa.Column("device_id", sa.Uuid()),
        _ts("created_at"),
    )

    op.create_index(
        "ix_stock_movements_variant_created", "stock_movements", ["variant_id", "created_at"]
    )
    op.create_index("ix_product_variants_product", "product_variants", ["product_id"])
    op.create_index("ix_products_category", "products", ["category_id"])
    op.create_index("ix_product_images_product", "product_images", ["product_id"])
    op.create_index("ix_audit_log_entity", "audit_log", ["entity", "entity_id"])
    for table in (
        "categories",
        "products",
        "product_variants",
        "product_images",
        "stock_movements",
    ):
        op.create_index(f"ix_{table}_change_seq", table, ["change_seq"])
    op.execute(
        "CREATE INDEX ix_products_search_trgm ON products USING gin (search_text gin_trgm_ops)"
    )


def downgrade() -> None:
    for table in (
        "audit_log",
        "stock_movements",
        "product_images",
        "product_variants",
        "products",
        "categories",
    ):
        op.drop_table(table)
    op.execute("DROP SEQUENCE sku_seq")

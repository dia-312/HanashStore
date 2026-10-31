import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.ids import uuid7


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    pin_hash: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SyncClock(Base):
    """Single row; write transactions lock it FOR UPDATE to take change_seq (SPEC section 8)."""

    __tablename__ = "sync_clock"
    __table_args__ = (CheckConstraint("id = 1", name="sync_clock_single_row"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AuthSession(Base):
    """Server-side session so it can be revoked. Only the SHA-256 of the cookie token is stored."""

    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    token_hash: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    category_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("categories.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # Normalized name, category, description and the variants' color, size, SKU (SPEC section 9).
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class ProductVariant(Base):
    __tablename__ = "product_variants"
    __table_args__ = (
        # NULLS NOT DISTINCT: two variants with no color and no size are still the same variant.
        UniqueConstraint(
            "product_id",
            "color",
            "size",
            name="uq_variant_product_color_size",
            postgresql_nulls_not_distinct=True,
        ),
        CheckConstraint("price >= 0", name="variant_price_nonnegative"),
        CheckConstraint("min_stock >= 0", name="variant_min_stock_nonnegative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    sku: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    color: Mapped[str | None] = mapped_column(String)
    size: Mapped[str | None] = mapped_column(String)
    price: Mapped[int] = mapped_column(BigInteger, nullable=False)  # agorot
    min_stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Cache of the sum of stock_movements.qty; changed only together with a movement insert.
    stock_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class ProductImage(Base):
    __tablename__ = "product_images"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    product_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("products.id"), nullable=False)
    variant_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("product_variants.id"))
    thumb_url: Mapped[str] = mapped_column(String, nullable=False)
    full_url: Mapped[str] = mapped_column(String, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class StockMovement(Base):
    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint("qty <> 0", name="movement_qty_nonzero"),
        CheckConstraint(
            "type in ('opening','purchase','sale','sale_cancel','return','damage','adjustment')",
            name="movement_type_known",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    variant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product_variants.id"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)  # + in, - out
    type: Mapped[str] = mapped_column(String, nullable=False)
    ref_type: Mapped[str | None] = mapped_column(String)
    ref_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    note: Mapped[str | None] = mapped_column(Text)
    device_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("devices.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid7)
    entity: Mapped[str] = mapped_column(String, nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False)
    before: Mapped[Any | None] = mapped_column(JSONB)
    after: Mapped[Any | None] = mapped_column(JSONB)
    device_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ProcessedCommand(Base):
    """A pushed command kept with its result, so a resend changes nothing (SPEC section 8)."""

    __tablename__ = "processed_commands"
    __table_args__ = (
        CheckConstraint("status in ('applied','rejected')", name="processed_status_known"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)  # the client's command id
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"), nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    result: Mapped[Any | None] = mapped_column(JSONB)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    shop_name: Mapped[str | None] = mapped_column(String)
    phone: Mapped[str | None] = mapped_column(String)
    area: Mapped[str | None] = mapped_column(String)
    address: Mapped[str | None] = mapped_column(String)
    notes: Mapped[str | None] = mapped_column(Text)
    # Positive = he already owed this much when he was first added (agorot).
    opening_balance: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Invoice(Base):
    __tablename__ = "invoices"
    __table_args__ = (
        CheckConstraint("status in ('confirmed','cancelled')", name="invoice_status_known"),
        CheckConstraint(
            "discount >= 0 and discount <= subtotal and total = subtotal - discount",
            name="invoice_totals_consistent",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    number: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False)
    subtotal: Mapped[int] = mapped_column(BigInteger, nullable=False)
    discount: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    total: Mapped[int] = mapped_column(BigInteger, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class InvoiceLine(Base):
    __tablename__ = "invoice_lines"
    __table_args__ = (
        CheckConstraint("qty > 0", name="invoice_line_qty_positive"),
        CheckConstraint("unit_price >= 0", name="invoice_line_price_nonnegative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    invoice_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("invoices.id"), nullable=False)
    variant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("product_variants.id"), nullable=False)
    product_name: Mapped[str] = mapped_column(String, nullable=False)
    variant_label: Mapped[str] = mapped_column(String, nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[int] = mapped_column(BigInteger, nullable=False)
    line_total: Mapped[int] = mapped_column(BigInteger, nullable=False)
    discount_share: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Payment(Base):
    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("method in ('cash','transfer','cheque')", name="payment_method_known"),
        CheckConstraint("amount > 0", name="payment_amount_positive"),
        CheckConstraint("status in ('active','voided')", name="payment_status_known"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    number: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    customer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("customers.id"), nullable=False)
    invoice_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("invoices.id"))
    method: Mapped[str] = mapped_column(String, nullable=False)
    amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    void_reason: Mapped[str | None] = mapped_column(Text)
    device_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("devices.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    change_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)

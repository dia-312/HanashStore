"""API shapes for the catalog and stock. Money is integer agorot; text fields have max lengths."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from app.models import ProductVariant

MAX_QTY = 100_000
MAX_PRICE = 10_000_000 * 100

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Description = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
Price = Annotated[int, Field(ge=0, le=MAX_PRICE)]
MinStock = Annotated[int, Field(ge=0, le=MAX_QTY)]
Qty = Annotated[int, Field(ge=1, le=MAX_QTY)]

StockStatus = Literal["ok", "low", "out"]


def stock_status(qty: int, min_stock: int) -> StockStatus:
    """Out = quantity <= 0. Low = quantity <= minimum level (SPEC section 4, F3)."""
    if qty <= 0:
        return "out"
    return "low" if qty <= min_stock else "ok"


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class CategoryOut(Out):
    id: uuid.UUID
    name: str
    sort_order: int
    is_active: bool
    product_count: int = 0


class CategoryCreate(BaseModel):
    name: Name


class CategoryPatch(BaseModel):
    name: Name | None = None
    sort_order: int | None = Field(default=None, ge=0, le=10_000)
    is_active: bool | None = None


class VariantOut(Out):
    id: uuid.UUID
    product_id: uuid.UUID
    sku: str
    color: str | None
    size: str | None
    price: int
    min_stock: int
    stock_qty: int
    is_active: bool
    status: StockStatus

    @classmethod
    def of(cls, v: ProductVariant) -> "VariantOut":
        return cls(
            id=v.id,
            product_id=v.product_id,
            sku=v.sku,
            color=v.color,
            size=v.size,
            price=v.price,
            min_stock=v.min_stock,
            stock_qty=v.stock_qty,
            is_active=v.is_active,
            status=stock_status(v.stock_qty, v.min_stock),
        )


class ImageOut(Out):
    id: uuid.UUID
    product_id: uuid.UUID
    variant_id: uuid.UUID | None
    thumb_url: str
    full_url: str
    sort_order: int


class ProductListItem(BaseModel):
    id: uuid.UUID
    name: str
    category_id: uuid.UUID
    category_name: str
    is_active: bool
    thumb_url: str | None
    variant_count: int
    price_min: int | None
    price_max: int | None
    stock_total: int
    low_count: int
    out_count: int


class ProductPage(BaseModel):
    items: list[ProductListItem]
    next_cursor: str | None


class ProductDetail(BaseModel):
    id: uuid.UUID
    name: str
    category_id: uuid.UUID
    category_name: str
    description: str | None
    is_active: bool
    images: list[ImageOut]
    variants: list[VariantOut]


class ProductCreate(BaseModel):
    name: Name
    category_id: uuid.UUID
    description: Description | None = None


class ProductPatch(BaseModel):
    name: Name | None = None
    category_id: uuid.UUID | None = None
    description: Description | None = None
    is_active: bool | None = None


class VariantCreate(BaseModel):
    color: ShortText | None = None
    size: ShortText | None = None
    price: Price
    min_stock: MinStock = 0
    opening_qty: Annotated[int, Field(ge=0, le=MAX_QTY)] = 0


class VariantPatch(BaseModel):
    color: ShortText | None = None
    size: ShortText | None = None
    price: Price | None = None
    min_stock: MinStock | None = None
    is_active: bool | None = None


class VariantListItem(BaseModel):
    id: uuid.UUID
    product_id: uuid.UUID
    product_name: str
    sku: str
    color: str | None
    size: str | None
    price: int
    min_stock: int
    stock_qty: int
    status: StockStatus
    thumb_url: str | None


class VariantPage(BaseModel):
    items: list[VariantListItem]
    next_cursor: str | None


class MovementOut(BaseModel):
    id: uuid.UUID
    qty: int
    type: str
    note: str | None
    ref_type: str | None
    ref_id: uuid.UUID | None
    created_at: datetime
    running_total: int


class MovementPage(BaseModel):
    items: list[MovementOut]
    next_cursor: str | None


class PurchaseItem(BaseModel):
    movement_id: uuid.UUID  # made by the device; a repeat of the same id has no effect
    variant_id: uuid.UUID
    qty: Qty


class PurchasePayload(BaseModel):
    """stock.purchase: goods received, one line per variant."""

    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    items: Annotated[list[PurchaseItem], Field(min_length=1, max_length=200)]


class AdjustPayload(BaseModel):
    """stock.adjust: the rep's physical count. The server works out the difference."""

    movement_id: uuid.UUID
    variant_id: uuid.UUID
    counted_qty: Annotated[int, Field(ge=0, le=MAX_QTY)]
    expected_qty: Annotated[int, Field(ge=0, le=MAX_QTY * 10)] | None = None  # what the device saw
    note: Note  # required: why the count differs


class DamagePayload(BaseModel):
    """stock.damage: goods written off."""

    movement_id: uuid.UUID
    variant_id: uuid.UUID
    qty: Qty
    note: Note


class CommandIn(BaseModel):
    id: uuid.UUID
    type: Annotated[str, StringConstraints(max_length=50)]
    schema_version: int
    payload: dict[str, Any]
    created_at: datetime


class PushRequest(BaseModel):
    device_id: uuid.UUID
    commands: Annotated[list[CommandIn], Field(max_length=50)]


class SyncCategory(Out):
    id: uuid.UUID
    name: str
    sort_order: int
    is_active: bool
    change_seq: int


class SyncProduct(Out):
    id: uuid.UUID
    category_id: uuid.UUID
    name: str
    description: str | None
    search_text: str
    is_active: bool
    change_seq: int


class SyncVariant(Out):
    id: uuid.UUID
    product_id: uuid.UUID
    sku: str
    color: str | None
    size: str | None
    price: int
    min_stock: int
    stock_qty: int
    is_active: bool
    change_seq: int


class SyncImage(Out):
    id: uuid.UUID
    product_id: uuid.UUID
    variant_id: uuid.UUID | None
    thumb_url: str
    full_url: str
    sort_order: int
    deleted_at: datetime | None
    change_seq: int


class SyncCustomer(Out):
    id: uuid.UUID
    name: str
    shop_name: str | None
    phone: str | None
    area: str | None
    address: str | None
    notes: str | None
    opening_balance: int
    search_text: str
    is_active: bool
    # Worked out when the page is built (opening + invoices - returns - payments), never stored.
    balance: int = 0
    change_seq: int


class SyncInvoice(Out):
    id: uuid.UUID
    number: str
    customer_id: uuid.UUID
    status: str
    subtotal: int
    discount: int
    total: int
    note: str | None
    issued_at: datetime
    delivered_at: datetime | None
    cancelled_at: datetime | None
    cancel_reason: str | None
    change_seq: int


class SyncInvoiceLine(Out):
    id: uuid.UUID
    invoice_id: uuid.UUID
    variant_id: uuid.UUID
    product_name: str
    variant_label: str
    qty: int
    unit_price: int
    line_total: int
    discount_share: int
    sort_order: int
    change_seq: int


class SyncPayment(Out):
    id: uuid.UUID
    number: str
    customer_id: uuid.UUID
    invoice_id: uuid.UUID | None
    method: str
    amount: int
    paid_at: datetime
    note: str | None
    status: str
    voided_at: datetime | None
    void_reason: str | None
    change_seq: int


class PullChanges(BaseModel):
    categories: list[SyncCategory]
    products: list[SyncProduct]
    variants: list[SyncVariant]
    images: list[SyncImage]
    customers: list[SyncCustomer]
    invoices: list[SyncInvoice]
    invoice_lines: list[SyncInvoiceLine]
    payments: list[SyncPayment]


class PullPage(BaseModel):
    changes: PullChanges
    cursor: int
    has_more: bool
    # Business settings travel with every pull: a handful of values, always current.
    settings: dict[str, Any] = {}


class RowIssue(BaseModel):
    row: int  # spreadsheet row number, 1 = the header row
    field: str
    code: str  # machine code; the app shows it in Arabic
    detail: str | None = None


class PreviewRow(BaseModel):
    row: int
    product: str
    category: str
    color: str | None
    size: str | None
    price: int
    qty: int


class ImportReport(BaseModel):
    dry_run: bool
    committed: bool
    rows: int
    mapped_columns: dict[str, str]
    ignored_columns: list[str]
    errors: list[RowIssue]
    errors_total: int
    new_categories: int
    new_products: int
    new_variants: int
    skipped_existing: int  # variants that already exist: left untouched
    opening_units: int
    preview: list[PreviewRow]


DocNumber = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}-\d{6,9}$")]
Text500 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
PaymentMethod = Literal["cash", "transfer", "cheque"]


class CustomerPayload(BaseModel):
    """customer.upsert: add a customer or edit one."""

    customer_id: uuid.UUID
    name: Name
    shop_name: ShortText | None = None
    phone: ShortText | None = None
    area: ShortText | None = None
    address: Text500 | None = None
    notes: Description | None = None
    opening_balance: Annotated[int, Field(ge=-MAX_PRICE, le=MAX_PRICE)] = 0
    is_active: bool = True


class PaymentIn(BaseModel):
    payment_id: uuid.UUID
    number: DocNumber
    amount: Annotated[int, Field(ge=1, le=MAX_PRICE)]
    method: PaymentMethod
    note: Text500 | None = None

    @field_validator("number")
    @classmethod
    def _receipt_number(cls, value: str) -> str:
        if not value.startswith("REC-"):
            raise ValueError("a payment number looks like REC-000010")
        return value

    @model_validator(mode="after")
    def _cheque_needs_details(self) -> "PaymentIn":
        # The rep writes the cheque number, bank and date in the note (SPEC F10).
        if self.method == "cheque" and not (self.note or "").strip():
            raise ValueError("a cheque needs its details in the note")
        return self


class PaymentCreatePayload(PaymentIn):
    """payment.create: money received with no new order (paying off old debt, SPEC F10)."""

    customer_id: uuid.UUID
    paid_at: datetime  # the device clock when the rep recorded it


class PaymentVoidPayload(BaseModel):
    """payment.void: a payment recorded by mistake. It stays on record, marked voided."""

    payment_id: uuid.UUID
    voided_at: datetime
    reason: Note


class InvoiceLineIn(BaseModel):
    line_id: uuid.UUID
    variant_id: uuid.UUID
    qty: Qty
    unit_price: Price  # the price the customer agreed to; the server only warns if it changed


class InvoiceCreatePayload(BaseModel):
    """invoice.create: a confirmed sale, with the payment taken at checkout if any."""

    invoice_id: uuid.UUID
    number: DocNumber
    customer_id: uuid.UUID
    issued_at: datetime  # the device clock at confirmation (SPEC section 7)
    discount: Price = 0
    note: Text500 | None = None
    payment: PaymentIn | None = None
    lines: Annotated[list[InvoiceLineIn], Field(min_length=1, max_length=200)]

    @field_validator("number")
    @classmethod
    def _invoice_number(cls, value: str) -> str:
        if not value.startswith("INV-"):
            raise ValueError("an invoice number looks like INV-000042")
        return value


class MarkDeliveredPayload(BaseModel):
    invoice_id: uuid.UUID
    delivered_at: datetime


class CancelLine(BaseModel):
    variant_id: uuid.UUID
    qty: Qty


class CancelPayload(BaseModel):
    """invoice.cancel. `lines` is what the device knows, for its own stock preview: the server
    uses the invoice's own lines."""

    invoice_id: uuid.UUID
    cancelled_at: datetime
    reason: Note
    void_payment: bool = False
    lines: list[CancelLine] = []

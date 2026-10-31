"""Sync (SPEC section 8). Flagged for line-by-line review: idempotency, pull ordering.

Pull: changed rows after a `change_seq` cursor. A write transaction shares one `change_seq` across
all the rows it touches (an import writes thousands under one number), so a page always ends on a
whole group; it only passes the page size when a single transaction wrote more rows than that.

Push: the device's commands, each in its own transaction. The result of a command is stored with its
id, so the same id sent again returns the stored result and changes nothing.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select, text, union_all
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.changeseq import take_seq
from app.errors import ApiError
from app.models import (
    Category,
    Customer,
    Device,
    Invoice,
    InvoiceLine,
    Payment,
    ProcessedCommand,
    Product,
    ProductImage,
    ProductVariant,
)
from app.schemas import (
    AdjustPayload,
    CancelPayload,
    CommandIn,
    CustomerPayload,
    DamagePayload,
    InvoiceCreatePayload,
    MarkDeliveredPayload,
    PullChanges,
    PullPage,
    PurchasePayload,
    SyncCategory,
    SyncCustomer,
    SyncImage,
    SyncInvoice,
    SyncInvoiceLine,
    SyncPayment,
    SyncProduct,
    SyncVariant,
)
from app.services import catalog, customers, invoices, stock
from app.services import settings as settings_service

PULL_LIMIT = 1000
# The current command format and the one before it, so a device with old pending commands can
# still sync after an update (SPEC section 8).
SUPPORTED_SCHEMA = frozenset({1})

_TABLES = (
    Category,
    Product,
    ProductVariant,
    ProductImage,
    Customer,
    Invoice,
    InvoiceLine,
    Payment,
)

# Invoices, their lines and their payments are kept on the device for the last 12 months only
# (SPEC section 8); older ones are fetched when needed (returns, M7).
HISTORY = timedelta(days=366)


def _in_window(model: Any, cutoff: Any) -> list[Any]:
    if model is Invoice:
        return [Invoice.issued_at >= cutoff]
    if model is Payment:
        return [Payment.paid_at >= cutoff]
    if model is InvoiceLine:
        return [InvoiceLine.invoice_id.in_(select(Invoice.id).where(Invoice.issued_at >= cutoff))]
    return []


def pull(db: Session, cursor: int, limit: int = PULL_LIMIT) -> PullPage:
    cutoff = clock.utcnow() - HISTORY
    seqs = union_all(
        *(
            select(t.change_seq.label("seq")).where(t.change_seq > cursor, *_in_window(t, cutoff))
            for t in _TABLES
        )
    )
    seqs_sub = seqs.subquery()
    # The change_seq of the limit-th row: the page includes every row up to and including it.
    boundary = db.scalar(select(seqs_sub.c.seq).order_by(seqs_sub.c.seq).offset(limit - 1).limit(1))

    def rows(model: Any) -> list[Any]:
        query = select(model).where(model.change_seq > cursor, *_in_window(model, cutoff))
        if boundary is not None:
            query = query.where(model.change_seq <= boundary)
        return list(db.scalars(query.order_by(model.change_seq, model.id)))

    groups = [rows(t) for t in _TABLES]
    categories, products, variants, images, customer_rows, inv, lines, payments = groups
    has_more = boundary is not None and any(
        db.scalar(select(t.id).where(t.change_seq > boundary, *_in_window(t, cutoff)).limit(1))
        is not None
        for t in _TABLES
    )
    seen = [r.change_seq for group in groups for r in group]
    balances = customers.balances(db, [c.id for c in customer_rows])
    return PullPage(
        changes=PullChanges(
            categories=[SyncCategory.model_validate(r) for r in categories],
            products=[SyncProduct.model_validate(r) for r in products],
            variants=[SyncVariant.model_validate(r) for r in variants],
            images=[SyncImage.model_validate(r) for r in images],
            customers=[
                SyncCustomer.model_validate(c).model_copy(update={"balance": balances[c.id]})
                for c in customer_rows
            ],
            invoices=[SyncInvoice.model_validate(r) for r in inv],
            invoice_lines=[SyncInvoiceLine.model_validate(r) for r in lines],
            payments=[SyncPayment.model_validate(r) for r in payments],
        ),
        cursor=max(seen, default=cursor),
        has_more=has_more,
        settings=settings_service.get_all(db),
    )


def highest_numbers(db: Session) -> dict[str, int]:
    """The highest INV and REC numbers the server has, so a new or replacement device can start
    its own counters above them (SPEC section 7)."""

    def top(table: str) -> int:
        query = f"SELECT COALESCE(MAX(substring(number FROM '[0-9]+$')::bigint), 0) FROM {table}"
        return int(db.scalar(text(query)) or 0)

    return {"INV": top("invoices"), "REC": top("payments")}


@dataclass
class Applied:
    data: dict[str, Any]
    warnings: list[dict[str, Any]] = field(default_factory=list)


Handler = Callable[[Session, Device, dict[str, Any]], Applied]


_variant_state = stock.variant_states


def _purchase(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = PurchasePayload.model_validate(raw)
    seq = take_seq(db)
    applied = 0
    for item in body.items:
        result = stock.apply_movement(
            db,
            movement_id=item.movement_id,
            variant_id=item.variant_id,
            qty=item.qty,
            type="purchase",
            seq=seq,
            note=body.note or None,
            device_id=device.id,
        )
        applied += int(result.created)
    return Applied(
        {"applied": applied, "variants": _variant_state(db, [i.variant_id for i in body.items])}
    )


def _damage(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = DamagePayload.model_validate(raw)
    result = stock.apply_movement(
        db,
        movement_id=body.movement_id,
        variant_id=body.variant_id,
        qty=body.qty,
        type="damage",
        seq=take_seq(db),
        note=body.note,
        device_id=device.id,
    )
    return Applied(
        {"applied": int(result.created), "variants": _variant_state(db, [body.variant_id])}
    )


def _adjust(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = AdjustPayload.model_validate(raw)
    seq = take_seq(db)
    variant = stock.lock_variant(db, body.variant_id)
    warnings: list[dict[str, Any]] = []
    if body.expected_qty is not None and body.expected_qty != variant.stock_qty:
        warnings.append(
            {"code": "STOCK_DIFFERS", "expected": body.expected_qty, "actual": variant.stock_qty}
        )
    try:
        result = stock.adjust_to_count(
            db,
            movement_id=body.movement_id,
            variant_id=body.variant_id,
            counted=body.counted_qty,
            note=body.note,
            seq=seq,
            device_id=device.id,
        )
    except ApiError as e:
        if e.code != "NO_DIFFERENCE":
            raise
        # The count already matches (an earlier command got there): nothing to record, not an error.
        warnings.append({"code": "NO_DIFFERENCE"})
        return Applied({"applied": 0, "variants": _variant_state(db, [body.variant_id])}, warnings)
    return Applied(
        {"applied": int(result.created), "variants": _variant_state(db, [body.variant_id])},
        warnings,
    )


def _customer_upsert(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = CustomerPayload.model_validate(raw)
    customer = customers.upsert(
        db,
        customer_id=body.customer_id,
        name=body.name,
        shop_name=catalog.clean(body.shop_name),
        phone=catalog.clean(body.phone),
        area=catalog.clean(body.area),
        address=catalog.clean(body.address),
        notes=catalog.clean(body.notes),
        opening_balance=body.opening_balance,
        is_active=body.is_active,
        seq=take_seq(db),
        device_id=device.id,
    )
    return Applied(
        {
            "customer_id": str(customer.id),
            "customer_balance": customers.balance_of(db, customer.id),
            "customer_change_seq": customer.change_seq,
        }
    )


def _invoice_create(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = InvoiceCreatePayload.model_validate(raw)
    data, warnings = invoices.create_invoice(db, device, body, take_seq(db))
    return Applied(data, warnings)


def _invoice_mark_delivered(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = MarkDeliveredPayload.model_validate(raw)
    return Applied(invoices.mark_delivered(db, device, body, take_seq(db)))


def _invoice_cancel(db: Session, device: Device, raw: dict[str, Any]) -> Applied:
    body = CancelPayload.model_validate(raw)
    data, warnings = invoices.cancel_invoice(db, device, body, take_seq(db))
    return Applied(data, warnings)


HANDLERS: dict[str, Handler] = {
    "stock.purchase": _purchase,
    "stock.damage": _damage,
    "stock.adjust": _adjust,
    "customer.upsert": _customer_upsert,
    "invoice.create": _invoice_create,
    "invoice.mark_delivered": _invoice_mark_delivered,
    "invoice.cancel": _invoice_cancel,
}


def _rejected(
    command_id: uuid.UUID, code: str, message: str, details: dict[str, Any]
) -> dict[str, Any]:
    return {
        "id": str(command_id),
        "status": "rejected",
        "error": {"code": code, "message": message, "details": details},
    }


def _store(db: Session, device: Device, cmd: CommandIn, outcome: dict[str, Any]) -> None:
    db.add(
        ProcessedCommand(
            id=cmd.id,
            device_id=device.id,
            type=cmd.type,
            status=outcome["status"],
            result=outcome,
            received_at=clock.utcnow(),
        )
    )


def _stored(db: Session, command_id: uuid.UUID) -> dict[str, Any] | None:
    row = db.get(ProcessedCommand, command_id)
    result: dict[str, Any] | None = row.result if row is not None else None
    return result


def process_command(db: Session, device: Device, cmd: CommandIn) -> dict[str, Any]:
    """Apply one command in its own transaction and return its result (stored, for a repeat)."""
    if (stored := _stored(db, cmd.id)) is not None:
        db.rollback()
        return stored
    try:
        if cmd.schema_version not in SUPPORTED_SCHEMA:
            raise ApiError(
                422,
                "UNSUPPORTED_SCHEMA",
                "This command format is not supported",
                {"schema_version": cmd.schema_version},
            )
        handler = HANDLERS.get(cmd.type)
        if handler is None:
            raise ApiError(422, "UNKNOWN_COMMAND", "Unknown command type", {"type": cmd.type})
        applied = handler(db, device, cmd.payload)
        outcome: dict[str, Any] = {
            "id": str(cmd.id),
            "status": "applied",
            "data": applied.data,
            "warnings": applied.warnings,
        }
        _store(db, device, cmd, outcome)
        audit(db, "command", cmd.id, cmd.type, after={"status": "applied"}, device_id=device.id)
        db.commit()
        return outcome
    except IntegrityError:
        # Two requests carried the same command at once: the other one won, return its result.
        db.rollback()
        if (stored := _stored(db, cmd.id)) is not None:
            db.rollback()
            return stored
        raise
    except (ApiError, ValidationError) as e:
        # Nothing the command did is kept (also drops the change_seq it took), then the rejection
        # is stored so a resend gets the same answer.
        db.rollback()
        if isinstance(e, ValidationError):
            errors = [
                {"field": ".".join(str(p) for p in err["loc"]), "message": err["msg"]}
                for err in e.errors()
            ]
            outcome = _rejected(cmd.id, "VALIDATION_ERROR", "Invalid input", {"errors": errors})
        else:
            code = "VARIANT_NOT_FOUND" if e.code == "NOT_FOUND" else e.code
            outcome = _rejected(cmd.id, code, e.message, e.details)
        _store(db, device, cmd, outcome)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if (stored := _stored(db, cmd.id)) is not None:
                db.rollback()
                return stored
            raise
        return outcome


def push(
    db: Session, device: Device, commands: list[CommandIn]
) -> tuple[list[dict[str, Any]], int]:
    """Commands are applied in the order sent. Returns the results and the current sync cursor."""
    results = [process_command(db, device, cmd) for cmd in commands]
    cursor = int(db.scalar(text("SELECT last_seq FROM sync_clock WHERE id = 1")) or 0)
    db.rollback()
    return results, cursor

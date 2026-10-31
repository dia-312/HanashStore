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
    Device,
    ProcessedCommand,
    Product,
    ProductImage,
    ProductVariant,
)
from app.schemas import (
    AdjustPayload,
    CommandIn,
    DamagePayload,
    PullChanges,
    PullPage,
    PurchasePayload,
    SyncCategory,
    SyncImage,
    SyncProduct,
    SyncVariant,
)
from app.services import stock

PULL_LIMIT = 1000
# The current command format and the one before it, so a device with old pending commands can
# still sync after an update (SPEC section 8).
SUPPORTED_SCHEMA = frozenset({1})

_TABLES = (Category, Product, ProductVariant, ProductImage)


def pull(db: Session, cursor: int, limit: int = PULL_LIMIT) -> PullPage:
    seqs = union_all(
        *(select(t.change_seq.label("seq")).where(t.change_seq > cursor) for t in _TABLES)
    )
    seqs_sub = seqs.subquery()
    # The change_seq of the limit-th row: the page includes every row up to and including it.
    boundary = db.scalar(select(seqs_sub.c.seq).order_by(seqs_sub.c.seq).offset(limit - 1).limit(1))

    def rows(model: Any) -> list[Any]:
        query = select(model).where(model.change_seq > cursor)
        if boundary is not None:
            query = query.where(model.change_seq <= boundary)
        return list(db.scalars(query.order_by(model.change_seq, model.id)))

    categories, products, variants, images = (rows(t) for t in _TABLES)
    has_more = boundary is not None and any(
        db.scalar(select(t.id).where(t.change_seq > boundary).limit(1)) is not None for t in _TABLES
    )
    seen = [r.change_seq for group in (categories, products, variants, images) for r in group]
    return PullPage(
        changes=PullChanges(
            categories=[SyncCategory.model_validate(r) for r in categories],
            products=[SyncProduct.model_validate(r) for r in products],
            variants=[SyncVariant.model_validate(r) for r in variants],
            images=[SyncImage.model_validate(r) for r in images],
        ),
        cursor=max(seen, default=cursor),
        has_more=has_more,
    )


@dataclass
class Applied:
    data: dict[str, Any]
    warnings: list[dict[str, Any]] = field(default_factory=list)


Handler = Callable[[Session, Device, dict[str, Any]], Applied]


def _variant_state(db: Session, variant_ids: list[uuid.UUID]) -> list[dict[str, Any]]:
    """What the device needs to show the new stock right away, without waiting for a pull."""
    out: list[dict[str, Any]] = []
    for variant_id in dict.fromkeys(variant_ids):
        variant = db.get(ProductVariant, variant_id)
        if variant is not None:
            out.append(
                {
                    "id": str(variant.id),
                    "stock_qty": variant.stock_qty,
                    "change_seq": variant.change_seq,
                }
            )
    return out


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


HANDLERS: dict[str, Handler] = {
    "stock.purchase": _purchase,
    "stock.damage": _damage,
    "stock.adjust": _adjust,
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

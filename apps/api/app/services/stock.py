"""Stock movements (SPEC sections 6 and 7). Flagged for line-by-line review: changes stock.

Stock of a variant is the sum of its movements. `product_variants.stock_qty` is only a cache and is
changed here, in the same transaction as the movement insert, and nowhere else.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.models import ProductVariant, StockMovement

MAX_MOVEMENT_QTY = 100_000  # SPEC section 13

# +1 stock in, -1 stock out. An adjustment's sign comes from the difference it records.
_SIGN = {
    "opening": 1,
    "purchase": 1,
    "sale": -1,
    "sale_cancel": 1,
    "return": 1,
    "damage": -1,
    "adjustment": 0,
}
# These may never take stock below zero (overselling is blocked, SPEC section 7).
_CANNOT_GO_NEGATIVE = {"sale", "damage", "adjustment"}


@dataclass
class MovementResult:
    movement: StockMovement
    created: bool  # False when the same client id was already applied


def lock_variant(db: Session, variant_id: uuid.UUID) -> ProductVariant:
    variant = db.execute(
        select(ProductVariant)
        .where(ProductVariant.id == variant_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if variant is None:
        raise ApiError(404, "NOT_FOUND", "Variant not found", {"variant_id": str(variant_id)})
    return variant


def apply_movement(
    db: Session,
    *,
    movement_id: uuid.UUID,
    variant_id: uuid.UUID,
    qty: int,
    type: str,
    seq: int,
    note: str | None = None,
    device_id: uuid.UUID | None = None,
    ref_type: str | None = None,
    ref_id: uuid.UUID | None = None,
) -> MovementResult:
    """Insert one movement and update the stock cache.

    `qty` is the amount for every type except `adjustment`, where it is the signed difference.
    Sending the same `movement_id` again changes nothing (the client retries after a lost reply)."""
    if type not in _SIGN:
        raise ApiError(422, "VALIDATION_ERROR", f"Unknown movement type {type}")
    sign = _SIGN[type]
    if sign != 0 and qty <= 0:
        raise ApiError(422, "VALIDATION_ERROR", "Quantity must be greater than zero")
    if qty == 0 or abs(qty) > MAX_MOVEMENT_QTY:
        raise ApiError(422, "VALIDATION_ERROR", f"Quantity must be 1 to {MAX_MOVEMENT_QTY}")
    signed = qty * sign if sign else qty

    variant = lock_variant(db, variant_id)
    existing = db.get(StockMovement, movement_id)
    if existing is not None:
        if existing.variant_id != variant_id or existing.qty != signed or existing.type != type:
            raise ApiError(409, "MOVEMENT_ID_CONFLICT", "This id was used for a different movement")
        return MovementResult(existing, created=False)
    if type == "purchase" and not variant.is_active:
        raise ApiError(409, "VARIANT_INACTIVE", "Variant is deactivated")

    new_qty = variant.stock_qty + signed
    if new_qty < 0 and type in _CANNOT_GO_NEGATIVE:
        raise ApiError(
            409,
            "INSUFFICIENT_STOCK",
            "Stock cannot go below zero",
            {"variant_id": str(variant_id), "available": variant.stock_qty},
        )

    now = clock.utcnow()
    movement = StockMovement(
        id=movement_id,
        variant_id=variant_id,
        qty=signed,
        type=type,
        ref_type=ref_type,
        ref_id=ref_id,
        note=note,
        device_id=device_id,
        created_at=now,
        change_seq=seq,
    )
    db.add(movement)
    variant.stock_qty = new_qty
    variant.updated_at = now
    variant.change_seq = seq
    audit(
        db,
        "stock_movement",
        movement_id,
        type,
        before={"variant_id": str(variant_id), "stock_qty": new_qty - signed},
        after={"qty": signed, "stock_qty": new_qty, "note": note},
        device_id=device_id,
    )
    db.flush()
    return MovementResult(movement, created=True)


def adjust_to_count(
    db: Session,
    *,
    movement_id: uuid.UUID,
    variant_id: uuid.UUID,
    counted: int,
    note: str,
    seq: int,
    device_id: uuid.UUID | None = None,
) -> MovementResult:
    """Record the difference between a physical count and the system (SPEC section 7)."""
    if counted < 0 or counted > MAX_MOVEMENT_QTY:
        raise ApiError(422, "VALIDATION_ERROR", f"Counted quantity must be 0 to {MAX_MOVEMENT_QTY}")
    existing = db.get(StockMovement, movement_id)
    if existing is not None:  # a retry: the first request already recorded the difference
        return apply_movement(
            db,
            movement_id=movement_id,
            variant_id=variant_id,
            qty=existing.qty,
            type="adjustment",
            seq=seq,
            note=note,
            device_id=device_id,
        )
    variant = lock_variant(db, variant_id)
    difference = counted - variant.stock_qty
    if difference == 0:
        raise ApiError(409, "NO_DIFFERENCE", "The count equals the current stock")
    return apply_movement(
        db,
        movement_id=movement_id,
        variant_id=variant_id,
        qty=difference,
        type="adjustment",
        seq=seq,
        note=note,
        device_id=device_id,
    )


def movement_total(db: Session, variant_id: uuid.UUID) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(StockMovement.qty), 0)).where(
                StockMovement.variant_id == variant_id
            )
        )
        or 0
    )


def stock_mismatches(db: Session) -> list[tuple[uuid.UUID, int, int]]:
    """(variant_id, cached stock_qty, sum of movements) for every variant where they differ."""
    sums = (
        select(StockMovement.variant_id, func.sum(StockMovement.qty).label("total"))
        .group_by(StockMovement.variant_id)
        .subquery()
    )
    rows = db.execute(
        select(ProductVariant.id, ProductVariant.stock_qty, func.coalesce(sums.c.total, 0))
        .outerjoin(sums, sums.c.variant_id == ProductVariant.id)
        .where(ProductVariant.stock_qty != func.coalesce(sums.c.total, 0))
    ).all()
    return [(r[0], r[1], int(r[2])) for r in rows]

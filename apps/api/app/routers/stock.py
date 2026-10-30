"""Stock-in, count adjustment and damage. Flagged for line-by-line review (changes stock).

Plain REST in M2; M3 moves these onto the sync push path. Every request carries client-made ids and
a repeated id has no effect, so wrapping them in commands later keeps the same rules."""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.models import ProductVariant
from app.schemas import (
    StockAdjustRequest,
    StockDamageRequest,
    StockInRequest,
    StockResult,
    VariantOut,
)
from app.services import stock

router = APIRouter(prefix="/stock", tags=["stock"])


def _result(db: Session, applied: int, variant_ids: list[uuid.UUID]) -> StockResult:
    variants = [db.get(ProductVariant, vid) for vid in dict.fromkeys(variant_ids)]
    return StockResult(applied=applied, variants=[VariantOut.of(v) for v in variants if v])


@router.post("/in", response_model=StockResult)
def stock_in(
    body: StockInRequest,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> StockResult:
    seq = take_seq(db)
    applied = 0
    for item in body.items:
        result = stock.apply_movement(
            db,
            movement_id=item.id,
            variant_id=item.variant_id,
            qty=item.qty,
            type="purchase",
            seq=seq,
            note=body.note or None,
            device_id=auth.device.id,
        )
        applied += result.created
    db.commit()
    return _result(db, applied, [i.variant_id for i in body.items])


@router.post("/adjust", response_model=StockResult)
def stock_adjust(
    body: StockAdjustRequest,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> StockResult:
    result = stock.adjust_to_count(
        db,
        movement_id=body.id,
        variant_id=body.variant_id,
        counted=body.counted_qty,
        note=body.note,
        seq=take_seq(db),
        device_id=auth.device.id,
    )
    db.commit()
    return _result(db, int(result.created), [body.variant_id])


@router.post("/damage", response_model=StockResult)
def stock_damage(
    body: StockDamageRequest,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> StockResult:
    result = stock.apply_movement(
        db,
        movement_id=body.id,
        variant_id=body.variant_id,
        qty=body.qty,
        type="damage",
        seq=take_seq(db),
        note=body.note,
        device_id=auth.device.id,
    )
    db.commit()
    return _result(db, int(result.created), [body.variant_id])

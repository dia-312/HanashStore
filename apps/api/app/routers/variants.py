import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.models import Product, ProductImage, ProductVariant, StockMovement
from app.pagination import DEFAULT_LIMIT, Limit, decode_cursor, encode_cursor
from app.routers.products import search_filter
from app.schemas import (
    MovementOut,
    MovementPage,
    VariantListItem,
    VariantOut,
    VariantPage,
    VariantPatch,
    stock_status,
)
from app.services import catalog

router = APIRouter(prefix="/variants", tags=["variants"])


@router.get("", response_model=VariantPage)
def list_variants(
    q: str | None = None,
    cursor: str | None = None,
    limit: Limit = DEFAULT_LIMIT,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> VariantPage:
    """Active variants of active products, for pickers such as stock-in."""
    thumb = (
        select(ProductImage.thumb_url)
        .where(
            ProductImage.product_id == Product.id,
            ProductImage.variant_id.is_(None),
            ProductImage.deleted_at.is_(None),
        )
        .order_by(ProductImage.sort_order, ProductImage.id)
        .limit(1)
        .correlate(Product)
        .scalar_subquery()
    )
    query = (
        select(ProductVariant, Product.name, thumb)
        .join(Product, Product.id == ProductVariant.product_id)
        .where(ProductVariant.is_active.is_(True), Product.is_active.is_(True))
    )
    if q:
        query = query.where(*search_filter(q))
    if cursor:
        name, sku = decode_cursor(cursor, 2)
        query = query.where(
            or_(Product.name > name, and_(Product.name == name, ProductVariant.sku > sku))
        )
    rows = db.execute(query.order_by(Product.name, ProductVariant.sku).limit(limit + 1)).all()
    items = [
        VariantListItem(
            id=v.id,
            product_id=v.product_id,
            product_name=product_name,
            sku=v.sku,
            color=v.color,
            size=v.size,
            price=v.price,
            min_stock=v.min_stock,
            stock_qty=v.stock_qty,
            status=stock_status(v.stock_qty, v.min_stock),
            thumb_url=thumb_url,
        )
        for v, product_name, thumb_url in rows[:limit]
    ]
    next_cursor = (
        encode_cursor([items[-1].product_name, items[-1].sku]) if len(rows) > limit else None
    )
    return VariantPage(items=items, next_cursor=next_cursor)


def _get_variant(db: Session, variant_id: uuid.UUID) -> ProductVariant:
    variant = db.get(ProductVariant, variant_id)
    if variant is None:
        raise ApiError(404, "NOT_FOUND", "Variant not found")
    return variant


@router.patch("/{variant_id}", response_model=VariantOut)
def patch_variant(
    variant_id: uuid.UUID,
    body: VariantPatch,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> VariantOut:
    variant = _get_variant(db, variant_id)
    changes: dict[str, Any] = body.model_dump(exclude_unset=True)
    # price, min_stock and is_active can't be null; color and size can be cleared with null.
    for key in ("price", "min_stock", "is_active"):
        if key in changes and changes[key] is None:
            raise ApiError(422, "VALIDATION_ERROR", f"{key} cannot be null")
    if changes:
        locked = variant  # no stock change here, so no row lock is needed
        catalog.update_variant(db, locked, changes, take_seq(db), auth.device.id)
        db.commit()
    return VariantOut.of(variant)


@router.get("/{variant_id}/movements", response_model=MovementPage)
def variant_movements(
    variant_id: uuid.UUID,
    cursor: str | None = None,
    limit: Limit = DEFAULT_LIMIT,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> MovementPage:
    """Newest first, each row with the running total after it (SPEC section 4, F3)."""
    _get_variant(db, variant_id)
    m = StockMovement
    running = (
        select(
            m,
            func.sum(m.qty).over(order_by=(m.created_at, m.id)).label("running_total"),
        )
        .where(m.variant_id == variant_id)
        .subquery()
    )
    query = select(running)
    if cursor:
        created_raw, last_id = decode_cursor(cursor, 2)
        created = datetime.fromisoformat(created_raw)
        query = query.where(
            or_(
                running.c.created_at < created,
                and_(running.c.created_at == created, running.c.id < uuid.UUID(last_id)),
            )
        )
    rows = db.execute(
        query.order_by(running.c.created_at.desc(), running.c.id.desc()).limit(limit + 1)
    ).all()
    items = [
        MovementOut(
            id=r.id,
            qty=r.qty,
            type=r.type,
            note=r.note,
            ref_type=r.ref_type,
            ref_id=r.ref_id,
            created_at=r.created_at,
            running_total=int(r.running_total),
        )
        for r in rows[:limit]
    ]
    next_cursor = (
        encode_cursor([items[-1].created_at.isoformat(), str(items[-1].id)])
        if len(rows) > limit
        else None
    )
    return MovementPage(items=items, next_cursor=next_cursor)

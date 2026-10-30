import uuid
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.models import Category, Product, ProductImage, ProductVariant
from app.normalize import normalize_arabic
from app.pagination import DEFAULT_LIMIT, Limit, decode_cursor, encode_cursor
from app.schemas import (
    ImageOut,
    ProductCreate,
    ProductDetail,
    ProductListItem,
    ProductPage,
    ProductPatch,
    VariantCreate,
    VariantOut,
)
from app.services import catalog

router = APIRouter(prefix="/products", tags=["products"])


def search_filter(query: str) -> list[Any]:
    """Every word typed must appear in the product's normalized search text (SPEC section 9 basics;
    prefix, synonyms and typo tolerance run on the device from M8)."""
    return [Product.search_text.contains(token) for token in normalize_arabic(query).split()]


def _thumb_subquery() -> Any:
    return (
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


def _list_query() -> Select[Any]:
    v = ProductVariant
    agg = (
        select(
            v.product_id.label("product_id"),
            func.count().label("variant_count"),
            func.min(v.price).label("price_min"),
            func.max(v.price).label("price_max"),
            func.sum(v.stock_qty).label("stock_total"),
            func.count().filter(v.stock_qty <= 0).label("out_count"),
            func.count()
            .filter(and_(v.stock_qty > 0, v.stock_qty <= v.min_stock))
            .label("low_count"),
        )
        .where(v.is_active.is_(True))
        .group_by(v.product_id)
        .subquery()
    )
    return (
        select(
            Product,
            Category.name,
            _thumb_subquery().label("thumb_url"),
            func.coalesce(agg.c.variant_count, 0),
            agg.c.price_min,
            agg.c.price_max,
            func.coalesce(agg.c.stock_total, 0),
            func.coalesce(agg.c.low_count, 0),
            func.coalesce(agg.c.out_count, 0),
        )
        .join(Category, Category.id == Product.category_id)
        .outerjoin(agg, agg.c.product_id == Product.id)
    )


@router.get("", response_model=ProductPage)
def list_products(
    q: str | None = None,
    category_id: uuid.UUID | None = None,
    include_inactive: bool = False,
    cursor: str | None = None,
    limit: Limit = DEFAULT_LIMIT,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> ProductPage:
    query = _list_query()
    if not include_inactive:
        query = query.where(Product.is_active.is_(True))
    if category_id is not None:
        query = query.where(Product.category_id == category_id)
    if q:
        query = query.where(*search_filter(q))
    if cursor:
        name, last_id = decode_cursor(cursor, 2)
        query = query.where(
            or_(Product.name > name, and_(Product.name == name, Product.id > uuid.UUID(last_id)))
        )
    rows = db.execute(query.order_by(Product.name, Product.id).limit(limit + 1)).all()
    page = rows[:limit]
    items = [
        ProductListItem(
            id=p.id,
            name=p.name,
            category_id=p.category_id,
            category_name=category_name,
            is_active=p.is_active,
            thumb_url=thumb,
            variant_count=int(count),
            price_min=price_min,
            price_max=price_max,
            stock_total=int(stock),
            low_count=int(low),
            out_count=int(out),
        )
        for p, category_name, thumb, count, price_min, price_max, stock, low, out in page
    ]
    more = len(rows) > limit
    next_cursor = encode_cursor([items[-1].name, str(items[-1].id)]) if more and items else None
    return ProductPage(items=items, next_cursor=next_cursor)


def product_detail(db: Session, product: Product) -> ProductDetail:
    category = db.get(Category, product.category_id)
    images = db.scalars(
        select(ProductImage)
        .where(ProductImage.product_id == product.id, ProductImage.deleted_at.is_(None))
        .order_by(ProductImage.sort_order, ProductImage.id)
    ).all()
    variants = db.scalars(
        select(ProductVariant)
        .where(ProductVariant.product_id == product.id)
        .order_by(ProductVariant.created_at, ProductVariant.id)
    ).all()
    return ProductDetail(
        id=product.id,
        name=product.name,
        category_id=product.category_id,
        category_name=category.name if category else "",
        description=product.description,
        is_active=product.is_active,
        images=[ImageOut.model_validate(i) for i in images],
        variants=[VariantOut.of(v) for v in variants],
    )


def _get_product(db: Session, product_id: uuid.UUID) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise ApiError(404, "NOT_FOUND", "Product not found")
    return product


def _active_category(db: Session, category_id: uuid.UUID) -> Category:
    category = db.get(Category, category_id)
    if category is None:
        raise ApiError(422, "VALIDATION_ERROR", "Unknown category", {"field": "category_id"})
    return category


@router.post("", response_model=ProductDetail, status_code=201)
def create_product(
    body: ProductCreate,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> ProductDetail:
    category = _active_category(db, body.category_id)
    product = catalog.create_product(
        db,
        name=body.name,
        category=category,
        description=body.description or None,
        seq=take_seq(db),
        device_id=auth.device.id,
    )
    db.commit()
    return product_detail(db, product)


@router.get("/{product_id}", response_model=ProductDetail)
def get_product(
    product_id: uuid.UUID,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> ProductDetail:
    return product_detail(db, _get_product(db, product_id))


@router.patch("/{product_id}", response_model=ProductDetail)
def patch_product(
    product_id: uuid.UUID,
    body: ProductPatch,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> ProductDetail:
    product = _get_product(db, product_id)
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "category_id" in changes:
        _active_category(db, changes["category_id"])
    if "description" in changes:
        changes["description"] = changes["description"] or None
    if changes:
        catalog.update_product(db, product, changes, take_seq(db), auth.device.id)
        db.commit()
    return product_detail(db, product)


@router.post("/{product_id}/variants", response_model=VariantOut, status_code=201)
def create_variant(
    product_id: uuid.UUID,
    body: VariantCreate,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> VariantOut:
    product = _get_product(db, product_id)
    variant = catalog.create_variant(
        db,
        product=product,
        color=body.color,
        size=body.size,
        price=body.price,
        min_stock=body.min_stock,
        opening_qty=body.opening_qty,
        seq=take_seq(db),
        device_id=auth.device.id,
    )
    db.commit()
    return VariantOut.of(variant)

"""Categories, products and variants: creation, edits and the denormalized search text."""

import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.ids import uuid7
from app.models import Category, Product, ProductVariant
from app.normalize import normalize_arabic
from app.services.stock import apply_movement


def next_sku(db: Session) -> str:
    """SKUs are always generated (the client has no product codes, SPEC section 4)."""
    number = db.execute(text("SELECT nextval('sku_seq')")).scalar_one()
    return f"SKU-{number:06d}"


def clean(value: str | None) -> str | None:
    """Trim; an empty string means "none" so (color, size) uniqueness can't be dodged with ''."""
    if value is None:
        return None
    value = " ".join(value.split())
    return value or None


def refresh_search_text(db: Session, product: Product, seq: int) -> None:
    """Normalized name, category, description and the active variants' color, size and SKU."""
    category = db.get(Category, product.category_id)
    rows = db.execute(
        select(ProductVariant.color, ProductVariant.size, ProductVariant.sku).where(
            ProductVariant.product_id == product.id, ProductVariant.is_active.is_(True)
        )
    ).all()
    parts = [product.name, category.name if category else "", product.description or ""]
    for color, size, sku in rows:
        parts.extend([color or "", size or "", sku])
    new_text = normalize_arabic(" ".join(parts))
    if new_text != product.search_text:
        product.search_text = new_text
        product.updated_at = clock.utcnow()
        product.change_seq = seq


def create_category(db: Session, name: str, seq: int, device_id: uuid.UUID | None) -> Category:
    category = Category(
        id=uuid7(),
        name=name,
        sort_order=0,
        is_active=True,
        updated_at=clock.utcnow(),
        change_seq=seq,
    )
    db.add(category)
    db.flush()
    audit(db, "category", category.id, "create", after={"name": name}, device_id=device_id)
    return category


def find_category_by_name(db: Session, name: str) -> Category | None:
    wanted = normalize_arabic(name)
    for category in db.scalars(select(Category)):
        if normalize_arabic(category.name) == wanted:
            return category
    return None


def create_product(
    db: Session,
    *,
    name: str,
    category: Category,
    description: str | None,
    seq: int,
    device_id: uuid.UUID | None,
) -> Product:
    now = clock.utcnow()
    product = Product(
        id=uuid7(),
        category_id=category.id,
        name=name,
        description=description,
        search_text="",
        is_active=True,
        created_at=now,
        updated_at=now,
        change_seq=seq,
    )
    db.add(product)
    db.flush()
    refresh_search_text(db, product, seq)
    audit(db, "product", product.id, "create", after={"name": name}, device_id=device_id)
    return product


def create_variant(
    db: Session,
    *,
    product: Product,
    color: str | None,
    size: str | None,
    price: int,
    min_stock: int,
    opening_qty: int,
    seq: int,
    device_id: uuid.UUID | None,
    refresh: bool = True,
) -> ProductVariant:
    color, size = clean(color), clean(size)
    clash = db.scalar(
        select(ProductVariant.id).where(
            ProductVariant.product_id == product.id,
            ProductVariant.color.is_not_distinct_from(color),
            ProductVariant.size.is_not_distinct_from(size),
        )
    )
    if clash is not None:
        raise ApiError(
            409,
            "DUPLICATE_VARIANT",
            "This product already has a variant with this color and size",
            {"variant_id": str(clash)},
        )
    now = clock.utcnow()
    variant = ProductVariant(
        id=uuid7(),
        product_id=product.id,
        sku=next_sku(db),
        color=color,
        size=size,
        price=price,
        min_stock=min_stock,
        stock_qty=0,
        is_active=True,
        created_at=now,
        updated_at=now,
        change_seq=seq,
    )
    db.add(variant)
    db.flush()
    audit(
        db,
        "variant",
        variant.id,
        "create",
        after={"sku": variant.sku, "price": price, "color": color, "size": size},
        device_id=device_id,
    )
    if opening_qty > 0:
        apply_movement(
            db,
            movement_id=uuid7(),
            variant_id=variant.id,
            qty=opening_qty,
            type="opening",
            seq=seq,
            device_id=device_id,
        )
    if refresh:
        refresh_search_text(db, product, seq)
    return variant


def update_variant(
    db: Session,
    variant: ProductVariant,
    changes: dict[str, Any],
    seq: int,
    device_id: uuid.UUID | None,
) -> None:
    """Edit price, min stock, color, size or the active flag. Price changes are audited."""
    before = {k: getattr(variant, k) for k in changes}
    if "color" in changes:
        changes["color"] = clean(changes["color"])
    if "size" in changes:
        changes["size"] = clean(changes["size"])
    if "color" in changes or "size" in changes:
        color = changes.get("color", variant.color)
        size = changes.get("size", variant.size)
        clash = db.scalar(
            select(ProductVariant.id).where(
                ProductVariant.product_id == variant.product_id,
                ProductVariant.id != variant.id,
                ProductVariant.color.is_not_distinct_from(color),
                ProductVariant.size.is_not_distinct_from(size),
            )
        )
        if clash is not None:
            raise ApiError(
                409,
                "DUPLICATE_VARIANT",
                "This product already has a variant with this color and size",
                {"variant_id": str(clash)},
            )
    for key, value in changes.items():
        setattr(variant, key, value)
    variant.updated_at = clock.utcnow()
    variant.change_seq = seq
    action = "price_change" if "price" in changes else "update"
    if "is_active" in changes:
        action = "activate" if changes["is_active"] else "deactivate"
    audit(db, "variant", variant.id, action, before=before, after=changes, device_id=device_id)
    product = db.get(Product, variant.product_id)
    if product is not None:
        db.flush()
        refresh_search_text(db, product, seq)


def update_product(
    db: Session,
    product: Product,
    changes: dict[str, Any],
    seq: int,
    device_id: uuid.UUID | None,
) -> None:
    before = {k: getattr(product, k) for k in changes}
    for key, value in changes.items():
        setattr(product, key, value)
    product.updated_at = clock.utcnow()
    product.change_seq = seq
    db.flush()
    refresh_search_text(db, product, seq)
    action = "update"
    if "is_active" in changes:
        action = "activate" if changes["is_active"] else "deactivate"
    audit(
        db,
        "product",
        product.id,
        action,
        before={k: str(v) if isinstance(v, uuid.UUID) else v for k, v in before.items()},
        after={k: str(v) if isinstance(v, uuid.UUID) else v for k, v in changes.items()},
        device_id=device_id,
    )


def update_category(
    db: Session,
    category: Category,
    changes: dict[str, Any],
    seq: int,
    device_id: uuid.UUID | None,
) -> None:
    before = {k: getattr(category, k) for k in changes}
    for key, value in changes.items():
        setattr(category, key, value)
    category.updated_at = clock.utcnow()
    category.change_seq = seq
    db.flush()
    if "name" in changes:  # the category name is part of every product's search text
        for product in db.scalars(select(Product).where(Product.category_id == category.id)):
            refresh_search_text(db, product, seq)
    action = "update"
    if "is_active" in changes:
        action = "activate" if changes["is_active"] else "deactivate"
    audit(db, "category", category.id, action, before=before, after=changes, device_id=device_id)

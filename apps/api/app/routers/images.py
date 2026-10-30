"""Product image upload, reorder and removal (SPEC section 12). Flagged for line-by-line review."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock, storage
from app.audit import audit
from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.ids import uuid7
from app.models import Product, ProductImage, ProductVariant
from app.schemas import ImageOut
from app.services import images

router = APIRouter(prefix="/products/{product_id}/images", tags=["images"])


class ImageMove(BaseModel):
    position: Annotated[int, Field(ge=0, le=images.MAX_IMAGES_PER_PRODUCT)]


def _active_images(db: Session, product_id: uuid.UUID) -> list[ProductImage]:
    return list(
        db.scalars(
            select(ProductImage)
            .where(ProductImage.product_id == product_id, ProductImage.deleted_at.is_(None))
            .order_by(ProductImage.sort_order, ProductImage.id)
        )
    )


def _renumber(rows: list[ProductImage], seq: int) -> None:
    now = clock.utcnow()
    for index, row in enumerate(rows):
        if row.sort_order != index:
            row.sort_order = index
            row.updated_at = now
            row.change_seq = seq


@router.post("", response_model=ImageOut, status_code=201)
def upload_image(
    product_id: uuid.UUID,
    file: Annotated[UploadFile, File()],
    variant_id: Annotated[uuid.UUID | None, Form()] = None,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> ImageOut:
    if db.get(Product, product_id) is None:
        raise ApiError(404, "NOT_FOUND", "Product not found")
    if variant_id is not None:
        variant = db.get(ProductVariant, variant_id)
        if variant is None or variant.product_id != product_id:
            raise ApiError(422, "VALIDATION_ERROR", "Variant does not belong to this product")
    existing = _active_images(db, product_id)
    if len(existing) >= images.MAX_IMAGES_PER_PRODUCT:
        raise ApiError(
            409,
            "TOO_MANY_IMAGES",
            f"A product can have at most {images.MAX_IMAGES_PER_PRODUCT} images",
        )
    # Read one byte past the limit so an oversized upload is noticed without buffering all of it.
    data = file.file.read(images.MAX_BYTES + 1)
    processed = images.process_upload(data)

    image_id = uuid7()
    thumb_path, full_path = storage.image_paths(product_id, image_id)
    thumb_url = storage.write_media(thumb_path, processed.thumb)
    full_url = storage.write_media(full_path, processed.full)
    seq = take_seq(db)
    row = ProductImage(
        id=image_id,
        product_id=product_id,
        variant_id=variant_id,
        thumb_url=thumb_url,
        full_url=full_url,
        sort_order=(max((i.sort_order for i in existing), default=-1)) + 1,
        updated_at=clock.utcnow(),
        change_seq=seq,
    )
    db.add(row)
    db.flush()
    audit(
        db,
        "product_image",
        image_id,
        "create",
        after={
            "product_id": str(product_id),
            "variant_id": str(variant_id) if variant_id else None,
        },
        device_id=auth.device.id,
    )
    db.commit()
    return ImageOut.model_validate(row)


def _get(db: Session, product_id: uuid.UUID, image_id: uuid.UUID) -> ProductImage:
    row = db.get(ProductImage, image_id)
    if row is None or row.product_id != product_id or row.deleted_at is not None:
        raise ApiError(404, "NOT_FOUND", "Image not found")
    return row


@router.patch("/{image_id}", response_model=list[ImageOut])
def move_image(
    product_id: uuid.UUID,
    image_id: uuid.UUID,
    body: ImageMove,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> list[ImageOut]:
    """Move an image to a zero-based position in the product's ordered list."""
    row = _get(db, product_id, image_id)
    rows = _active_images(db, product_id)
    rows.remove(row)
    rows.insert(min(body.position, len(rows)), row)
    _renumber(rows, take_seq(db))
    db.commit()
    return [ImageOut.model_validate(r) for r in rows]


@router.delete("/{image_id}", status_code=204)
def delete_image(
    product_id: uuid.UUID,
    image_id: uuid.UUID,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> None:
    """Soft delete: devices learn about it through sync. The files stay until a later cleanup."""
    row = _get(db, product_id, image_id)
    seq = take_seq(db)
    row.deleted_at = clock.utcnow()
    row.updated_at = row.deleted_at
    row.change_seq = seq
    db.flush()
    _renumber(_active_images(db, product_id), seq)
    audit(db, "product_image", image_id, "delete", device_id=auth.device.id)
    db.commit()

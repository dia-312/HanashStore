"""Load the large test dataset (SPEC section 17) into the dev database: categories, products,
variants, thumbnails and opening stock.

    python -m scripts.load_seed <seed_dir>          (from apps/api; seed_dir from seed_large.py)
    docker compose -f docker-compose.yml -f docker-compose.dev.yml exec api \n        python -m scripts.load_seed /seed

Refuses to run when the catalog already has products. Customers, invoices, payments and returns are
loaded by the milestones that create their tables. Fake data only: do not run it on a real database.
"""

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock, storage
from app.changeseq import take_seq
from app.db import get_engine
from app.ids import uuid7
from app.models import Category, Product, ProductImage, ProductVariant
from app.services import catalog
from app.services.stock import apply_movement


def _read(seed_dir: Path, name: str) -> list[dict[str, Any]]:
    data: list[dict[str, Any]] = json.loads((seed_dir / f"{name}.json").read_text("utf-8"))
    return data


def load(session: Session, seed_dir: Path) -> dict[str, int]:
    if session.scalar(select(func.count()).select_from(Product)):
        raise SystemExit("The catalog already has products; refusing to load the seed on top.")
    now = clock.utcnow()
    seq = take_seq(session)

    for c in _read(seed_dir, "categories"):
        session.add(
            Category(
                id=uuid.UUID(c["id"]),
                name=c["name"],
                sort_order=0,
                is_active=True,
                updated_at=now,
                change_seq=seq,
            )
        )
    session.flush()

    products: dict[str, Product] = {}
    for p in _read(seed_dir, "products"):
        product = Product(
            id=uuid.UUID(p["id"]),
            category_id=uuid.UUID(p["category_id"]),
            name=p["name"],
            description=None,
            search_text="",
            is_active=True,
            created_at=now,
            updated_at=now,
            change_seq=seq,
        )
        session.add(product)
        products[p["id"]] = product
    session.flush()

    thumbs = 0
    for p in _read(seed_dir, "products"):
        thumb = seed_dir / p["thumb"]
        if not thumb.exists():
            continue
        image_id = uuid7()
        thumb_path, full_path = storage.image_paths(uuid.UUID(p["id"]), image_id)
        data = thumb.read_bytes()
        session.add(
            ProductImage(
                id=image_id,
                product_id=uuid.UUID(p["id"]),
                variant_id=None,
                thumb_url=storage.write_media(thumb_path, data),
                full_url=storage.write_media(full_path, data),  # the seed only has 400 px images
                sort_order=0,
                updated_at=now,
                change_seq=seq,
            )
        )
        thumbs += 1

    variants = 0
    for v in _read(seed_dir, "variants"):
        variant = ProductVariant(
            id=uuid.UUID(v["id"]),
            product_id=uuid.UUID(v["product_id"]),
            sku=v["sku"],
            color=v["color"],
            size=v["size"],
            price=v["price"],
            min_stock=v["min_stock"],
            stock_qty=0,
            is_active=True,
            created_at=now,
            updated_at=now,
            change_seq=seq,
        )
        session.add(variant)
        session.flush()
        apply_movement(
            session,
            movement_id=uuid7(),
            variant_id=variant.id,
            qty=v["opening_qty"],
            type="opening",
            seq=seq,
        )
        variants += 1

    session.flush()
    for product in products.values():
        catalog.refresh_search_text(session, product, seq)
    session.commit()
    return {
        "categories": len(_read(seed_dir, "categories")),
        "products": len(products),
        "variants": variants,
        "thumbnails": thumbs,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("seed_dir", type=Path)
    args = parser.parse_args(argv)
    with Session(get_engine()) as session:
        print(load(session, args.seed_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())

import json
from pathlib import Path

from scripts import seed_large


def test_seed_is_deterministic_and_self_consistent(tmp_path: Path) -> None:
    a = seed_large.generate(tmp_path / "a", scale=0.02, thumbs=False)
    b = seed_large.generate(tmp_path / "b", scale=0.02, thumbs=False)
    assert a == b  # same seed, same data: a milestone check can be replayed exactly
    assert len(a["variants"]) == 5 * len(a["products"])
    on_disk = json.loads((tmp_path / "a" / "invoices.json").read_text(encoding="utf-8"))
    assert len(on_disk) == len(a["invoices"])
    numbers = [i["number"] for i in on_disk]
    assert numbers == sorted(numbers) and len(set(numbers)) == len(numbers)


def test_full_scale_counts_match_the_spec() -> None:
    assert (seed_large.N_PRODUCTS * seed_large.VARIANTS_PER_PRODUCT) == 2000
    assert (seed_large.N_CUSTOMERS, seed_large.N_INVOICES) == (500, 20_000)
    assert (seed_large.N_PAYMENTS, seed_large.N_RETURNS) == (15_000, 1_000)


def test_load_seed_fills_the_catalog_and_stock_is_consistent(tmp_path: Path) -> None:
    import pytest
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session

    from app.db import get_engine
    from app.models import Category, Product, ProductImage, ProductVariant, StockMovement
    from app.services.stock import stock_mismatches
    from scripts import load_seed

    seed_large.generate(tmp_path, scale=0.02)
    with Session(get_engine()) as session:
        counts = load_seed.load(session, tmp_path)
        assert counts["products"] == 8 and counts["variants"] == 40 and counts["thumbnails"] == 8
        for model, expected in (
            (Category, 5),
            (Product, 8),
            (ProductVariant, 40),
            (ProductImage, 8),
        ):
            assert session.scalar(select(func.count()).select_from(model)) == expected
        assert session.scalar(select(func.count()).select_from(StockMovement)) == 40
        assert stock_mismatches(session) == []
        assert all(p.search_text for p in session.scalars(select(Product)))
        with pytest.raises(SystemExit):  # a second load on top is refused
            load_seed.load(session, tmp_path)

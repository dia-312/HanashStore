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

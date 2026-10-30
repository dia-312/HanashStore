import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.money import MoneyError, parse_agorot, parse_quantity
from app.normalize import normalize_arabic
from app.schemas import stock_status

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "shared" / "normalize_cases.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=[c["input"] or "empty" for c in CASES])
def test_normalize_matches_the_shared_fixture(case: dict[str, str]) -> None:
    assert normalize_arabic(case["input"]) == case["expected"]


def test_spec_search_pairs_normalize_to_the_same_stem() -> None:
    # SPEC section 9: ارجيله finds أرجيلة because both normalize to the same word.
    assert normalize_arabic("ارجيله") == normalize_arabic("أرجيلة")


@pytest.mark.parametrize(
    ("raw", "agorot"),
    [
        ("12", 1200),
        ("12.5", 1250),
        ("12.50", 1250),
        ("0", 0),
        ("1,250.00", 125000),
        ("12,5", 1250),
        ("١٢٫٥٠", 1250),
        ("٢٥", 2500),
        (12, 1200),
        (12.3, 1230),
        (Decimal("4.05"), 405),
        (" 7 ", 700),
    ],
)
def test_parse_agorot(raw: str | int | float | Decimal, agorot: int) -> None:
    assert parse_agorot(raw) == agorot


@pytest.mark.parametrize("raw", ["", "abc", "-5", "1.234", "1e3", "12 ₪", "10000001", True])
def test_parse_agorot_rejects(raw: object) -> None:
    with pytest.raises(MoneyError):
        parse_agorot(raw)  # type: ignore[arg-type]


def test_parse_quantity() -> None:
    assert parse_quantity("12") == 12
    assert parse_quantity(12.0) == 12
    assert parse_quantity("٣٠") == 30
    for bad in ("1.5", "-1", "x", "100001", ""):
        with pytest.raises(MoneyError):
            parse_quantity(bad)


def test_stock_status_follows_spec_f3() -> None:
    assert stock_status(0, 0) == "out"
    assert stock_status(-2, 5) == "out"
    assert stock_status(3, 5) == "low"
    assert stock_status(5, 5) == "low"
    assert stock_status(6, 5) == "ok"
    assert stock_status(1, 0) == "ok"

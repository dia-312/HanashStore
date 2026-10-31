import json
import random
from pathlib import Path

import pytest

from app.services import billing

CASES = json.loads(
    (Path(__file__).resolve().parents[3] / "shared" / "billing_cases.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", CASES["discount"])
def test_discount_shares_match_the_shared_fixture(case: dict[str, object]) -> None:
    shares = billing.allocate_discount(case["line_totals"], case["discount"])  # type: ignore[arg-type]
    assert shares == case["shares"]
    assert sum(shares) == case["discount"]


@pytest.mark.parametrize("case", CASES["totals"])
def test_totals_match_the_shared_fixture(case: dict[str, object]) -> None:
    subtotal, total = billing.invoice_totals(case["line_totals"], case["discount"])  # type: ignore[arg-type]
    assert (subtotal, total) == (case["subtotal"], case["total"])


@pytest.mark.parametrize("case", CASES["remaining"])
def test_remaining_matches_the_shared_fixture(case: dict[str, int]) -> None:
    assert billing.remaining_on_invoice(case["total"], case["paid"]) == case["remaining"]


@pytest.mark.parametrize("case", CASES["balance"])
def test_balance_matches_the_shared_fixture(case: dict[str, int]) -> None:
    got = billing.customer_balance(
        case["opening"], case["invoices"], case["returns"], case["payments"]
    )
    assert got == case["balance"]


def test_the_shares_always_add_up_and_never_pass_the_line() -> None:
    rng = random.Random(7)
    for _ in range(500):
        totals = [rng.randint(0, 50_000) for _ in range(rng.randint(1, 8))]
        discount = rng.randint(0, sum(totals))
        shares = billing.allocate_discount(totals, discount)
        assert sum(shares) == discount
        assert all(0 <= s <= t for s, t in zip(shares, totals, strict=True))
        # Fair: no share is more than one agora away from the exact proportion.
        if sum(totals):
            for s, t in zip(shares, totals, strict=True):
                assert abs(s * sum(totals) - discount * t) < sum(totals)


def test_a_discount_larger_than_the_invoice_is_refused() -> None:
    with pytest.raises(ValueError):
        billing.allocate_discount([100, 200], 301)
    with pytest.raises(ValueError):
        billing.invoice_totals([100], -1)

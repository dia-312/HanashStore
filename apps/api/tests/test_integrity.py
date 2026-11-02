"""check-books and after-restore: the checks that make a backup worth trusting."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import cli
from app.services import customers, integrity
from tests import helpers

V1 = "/api/v1"


def trade(api: TestClient) -> dict[str, Any]:
    """A little of everything: a discounted sale and payment, a part return, a payment, a refund."""
    cid = helpers.customer(api, name="محل", opening_balance=1500)
    product = helpers.product(api)
    var = helpers.variant(api, product["id"], price=1000)["id"]
    helpers.stock_in(api, var, 50)
    sale = helpers.invoice_cmd(cid, [(var, 3, 1000)], discount=100, paid=1000)
    assert helpers.push_one(api, sale)["status"] == "applied"
    assert (
        helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")]))["status"] == "applied"
    )
    assert helpers.push_one(api, helpers.payment_cmd(cid, 300))["status"] == "applied"
    assert helpers.push_one(api, helpers.refund_cmd(cid, 100))["status"] == "applied"
    return {"customer": cid, "variant": var}


def test_clean_books_pass_and_are_counted(api: TestClient, db: Session) -> None:
    trade(api)
    report = integrity.check(db)
    assert report.ok, report.problems
    assert report.counts["invoices"] == 1 and report.counts["return_lines"] == 1
    assert report.counts["stock_movements"] >= 3


def test_an_empty_database_is_consistent(db: Session) -> None:
    assert integrity.check(db).ok


BREAKS = {
    "stock cache": "UPDATE product_variants SET stock_qty = stock_qty + 1",
    "subtotal": "UPDATE invoices SET subtotal = subtotal + 1, total = total + 1",
    "discount share": "UPDATE invoice_lines SET discount_share = discount_share + 1",
    "line total": "UPDATE invoice_lines SET line_total = line_total + 1",
    "return total": "UPDATE returns SET total = total + 1",
    "over-credit": "UPDATE return_lines SET amount = amount + 5000",
    "over-return": "UPDATE return_lines SET qty = qty + 9",
    "void without time": (
        "UPDATE payments SET status = 'voided', voided_at = NULL WHERE kind = 'refund'"
    ),
    "sync clock": "UPDATE sync_clock SET last_seq = 0",
    "no lines": "DELETE FROM return_lines; DELETE FROM invoice_lines",
}


@pytest.mark.parametrize("name", list(BREAKS))
def test_every_kind_of_damage_is_found(api: TestClient, db: Session, name: str) -> None:
    trade(api)
    for statement in BREAKS[name].split(";"):
        db.execute(text(statement))
    db.commit()
    report = integrity.check(db)
    assert not report.ok, name
    assert report.problems


@pytest.mark.parametrize(
    "damage",
    [
        "UPDATE invoices SET total = total + 1",
        "UPDATE payments SET amount = 0 WHERE kind = 'payment'",
    ],
)
def test_some_damage_the_database_refuses_before_it_can_happen(
    api: TestClient, db: Session, damage: str
) -> None:
    trade(api)
    with pytest.raises(IntegrityError):
        db.execute(text(damage))
        db.commit()
    db.rollback()


def test_a_balance_the_app_gets_wrong_is_found(
    api: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    trade(api)
    real = customers.balances
    monkeypatch.setattr(
        customers,
        "balances",
        lambda session, ids: {k: v + 1 for k, v in real(session, ids).items()},
    )
    report = integrity.check(db)
    assert any(p.startswith("balance of محل") for p in report.problems), report.problems


def test_the_command_says_so_with_its_exit_code(
    api: TestClient, db: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    trade(api)
    assert cli.main(["check-books"]) == 0
    assert "books are consistent" in capsys.readouterr().out
    db.execute(text("UPDATE product_variants SET stock_qty = stock_qty + 1"))
    db.commit()
    assert cli.main(["check-books"]) == 1
    out = capsys.readouterr().out
    assert "PROBLEM:" in out and "problem(s)" in out


def test_after_a_restore_every_device_is_told_to_read_again(
    api: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    def epoch() -> str:
        page: dict[str, Any] = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()
        value = str(page["epoch"])
        assert uuid.UUID(value)
        return value

    first = epoch()
    assert epoch() == first  # stable while nothing happens, also after writes
    trade(api)
    assert epoch() == first
    assert cli.main(["after-restore"]) == 0
    assert "new sync epoch" in capsys.readouterr().out
    second = epoch()
    assert second != first
    assert epoch() == second

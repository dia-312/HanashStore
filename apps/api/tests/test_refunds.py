import random
import uuid
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Customer, Payment
from app.services import customers, documents, statement
from tests import helpers

V1 = "/api/v1"


def _variant(api: TestClient, price: int = 4500, stock: int = 50) -> str:
    p = helpers.product(api)
    return str(helpers.variant(api, p["id"], price, opening_qty=stock)["id"])


def _balance(api: TestClient, customer_id: str) -> int:
    rows = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]["customers"]
    return int(next(c["balance"] for c in rows if c["id"] == customer_id))


def _code(result: dict[str, Any]) -> str:
    assert result["status"] == "rejected", result
    return str(result["error"]["code"])


def _applied(result: dict[str, Any]) -> dict[str, Any]:
    assert result["status"] == "applied", result
    data: dict[str, Any] = result["data"]
    return data


# --- the case that started it: he paid, then gave everything back --------------------------------


def test_returning_a_paid_invoice_leaves_credit_and_a_refund_clears_it(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, stock=10)
    cid = helpers.customer(api)
    sale = helpers.invoice_cmd(cid, [(v, 4, 2500)], paid=3000)  # 100.00 total, 30.00 paid
    assert helpers.push_one(api, sale)["status"] == "applied"
    _applied(helpers.push_one(api, helpers.return_cmd(sale, [(0, 4, "restock")])))
    assert _balance(api, cid) == -3000  # the shop owes him the 30.00 he paid

    refund = helpers.refund_cmd(cid, 3000)
    data = _applied(helpers.push_one(api, refund))
    assert data["customer_balance"] == 0
    assert _balance(api, cid) == 0
    row = db.get(Payment, uuid.UUID(refund["payload"]["refund_id"]))
    assert row is not None
    assert (row.kind, row.invoice_id, row.amount, row.status) == ("refund", None, 3000, "active")


def test_a_partial_refund_and_one_larger_than_the_credit_are_both_allowed(
    api: TestClient,
) -> None:
    cid = helpers.customer(api, opening_balance=-5000)  # he has 50.00 credit
    _applied(helpers.push_one(api, helpers.refund_cmd(cid, 2000)))
    assert _balance(api, cid) == -3000
    _applied(helpers.push_one(api, helpers.refund_cmd(cid, 9000, method="transfer")))
    assert _balance(api, cid) == 6000  # more than his credit: now he owes


def test_a_refund_is_not_a_payment_on_any_invoice(api: TestClient) -> None:
    v = _variant(api, stock=10)
    cid = helpers.customer(api)
    sale = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=500)
    helpers.push_one(api, sale)
    _applied(helpers.push_one(api, helpers.refund_cmd(cid, 300)))
    pulled = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]["payments"]
    assert sorted((p["kind"], p["amount"]) for p in pulled) == [("payment", 500), ("refund", 300)]
    assert _balance(api, cid) == 2000 - 500 + 300


# --- validation ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p.update(amount=0),
        lambda p: p.update(amount=-5),
        lambda p: p.update(number="REC-000001"),
        lambda p: p.update(method="gift"),
        lambda p: p.update(method="cheque", note=None),
        lambda p: p.update(note="x" * 501),
    ],
)
def test_bad_input_is_a_validation_error(api: TestClient, edit: Any) -> None:
    cid = helpers.customer(api)
    cmd = helpers.refund_cmd(cid, 1000)
    edit(cmd["payload"])
    assert _code(helpers.push_one(api, cmd)) == "VALIDATION_ERROR"


def test_a_cheque_with_its_details_is_accepted(api: TestClient) -> None:
    cid = helpers.customer(api)
    cmd = helpers.refund_cmd(cid, 1000, method="cheque", note="شيك 55 بنك فلسطين")
    _applied(helpers.push_one(api, cmd))


def test_an_unknown_customer_is_refused_and_nothing_is_written(
    api: TestClient, db: Session
) -> None:
    cmd = helpers.refund_cmd(str(uuid.uuid4()), 1000)
    assert _code(helpers.push_one(api, cmd)) == "CUSTOMER_NOT_FOUND"
    assert db.scalars(select(Payment)).all() == []


def test_a_reused_number_is_refused(api: TestClient, db: Session) -> None:
    cid = helpers.customer(api)
    first = helpers.refund_cmd(cid, 1000)
    _applied(helpers.push_one(api, first))
    second = helpers.refund_cmd(cid, 500, number=first["payload"]["number"])
    assert _code(helpers.push_one(api, second)) == "DUPLICATE_NUMBER"
    assert len(db.scalars(select(Payment)).all()) == 1
    assert _balance(api, cid) == 1000


def test_sending_the_same_command_again_changes_nothing(api: TestClient) -> None:
    cid = helpers.customer(api)
    cmd = helpers.refund_cmd(cid, 1000)
    first = helpers.push_one(api, cmd)
    assert helpers.push_one(api, cmd) == first
    assert _balance(api, cid) == 1000


def test_a_stopped_customer_can_still_be_refunded(api: TestClient) -> None:
    cid = helpers.customer(api)
    upsert = helpers.customer_cmd(name="محل النور", is_active=False)
    upsert["payload"]["customer_id"] = cid
    helpers.push_one(api, upsert)
    _applied(helpers.push_one(api, helpers.refund_cmd(cid, 100)))


# --- void ---------------------------------------------------------------------------------------


def test_voiding_a_refund_puts_the_credit_back(api: TestClient) -> None:
    cid = helpers.customer(api, opening_balance=-4000)
    refund = helpers.refund_cmd(cid, 4000)
    _applied(helpers.push_one(api, refund))
    assert _balance(api, cid) == 0
    voided = helpers.push_one(api, helpers.void_cmd(refund["payload"]["refund_id"]))
    assert _applied(voided)["customer_balance"] == -4000
    assert _balance(api, cid) == -4000
    again = helpers.push_one(api, helpers.void_cmd(refund["payload"]["refund_id"]))
    assert again["warnings"] == [{"code": "ALREADY_VOIDED"}]
    assert _balance(api, cid) == -4000


# --- numbers, audit, statement --------------------------------------------------------------------


def test_the_numbers_endpoint_counts_refunds_and_payments_separately(api: TestClient) -> None:
    cid = helpers.customer(api)
    _applied(helpers.push_one(api, helpers.payment_cmd(cid, 100, number="REC-000012")))
    _applied(helpers.push_one(api, helpers.refund_cmd(cid, 100, number="REF-000003")))
    numbers = api.get(V1 + "/sync/numbers").json()
    assert (numbers["REC"], numbers["REF"]) == (12, 3)


def test_a_refund_leaves_an_audit_row(api: TestClient, db: Session) -> None:
    cid = helpers.customer(api)
    cmd = helpers.refund_cmd(cid, 700)
    _applied(helpers.push_one(api, cmd))
    row = db.scalars(select(AuditLog).where(AuditLog.action == "refund")).one()
    assert row.after is not None
    assert row.after["amount"] == 700


def test_the_statement_shows_a_refund_as_a_debit_and_its_voided_row_only_on_request(
    api: TestClient, db: Session
) -> None:
    cid = helpers.customer(api, opening_balance=-4000)
    refund = helpers.refund_cmd(cid, 1500, refunded_at="2026-11-04T09:00:00Z")
    _applied(helpers.push_one(api, refund))
    start, end = date(2026, 11, 1), date(2026, 11, 30)
    stmt = statement.build(db, uuid.UUID(cid), start, end)
    assert [(r.kind, r.debit, r.credit, r.balance) for r in stmt.rows] == [
        ("opening", 0, 0, -4000),
        ("refund", 1500, 0, -2500),
    ]
    customer = db.get(Customer, uuid.UUID(cid))
    assert customer is not None
    doc = documents.statement_document(db, customer, stmt, start, end)
    row = doc["rows"][-1]
    assert (row["label"], row["debit"], row["credit"]) == ("استرداد", "₪ 15.00", None)

    helpers.push_one(api, helpers.void_cmd(refund["payload"]["refund_id"]))
    hidden = statement.build(db, uuid.UUID(cid), start, end)
    assert [r.kind for r in hidden.rows] == ["opening"]
    shown = statement.build(db, uuid.UUID(cid), start, end, True)
    assert [(r.kind, r.off) for r in shown.rows] == [("opening", None), ("refund", "voided")]
    assert shown.closing == hidden.closing == -4000
    doc = documents.statement_document(db, customer, shown, start, end)
    assert doc["rows"][-1]["label"] == "استرداد ملغى"


def test_a_later_period_starts_from_a_balance_with_the_refund_in_it(
    api: TestClient, db: Session
) -> None:
    cid = helpers.customer(api, opening_balance=-4000)
    _applied(
        helpers.push_one(api, helpers.refund_cmd(cid, 1500, refunded_at="2026-11-04T09:00:00Z"))
    )
    later = statement.build(db, uuid.UUID(cid), date(2026, 11, 10), date(2026, 11, 30))
    assert later.rows[0].balance == -2500


# --- the balance formula with everything in it ------------------------------------------------


def _random_history(api: TestClient, seed: int) -> str:
    rng = random.Random(seed)
    cid = helpers.customer(api, f"زبون {seed}", opening_balance=rng.choice([0, 7500, -2500]))
    v = _variant(api, stock=1000)
    invoices: list[dict[str, Any]] = []
    left: dict[str, list[int]] = {}
    money: list[str] = []  # payments and refunds, anything that can be voided
    for step in range(rng.randint(8, 16)):
        day = f"2026-11-{3 + step // 2:02d}T{9 + step % 8:02d}:00:00Z"
        kind = rng.choice(["invoice", "return", "payment", "refund", "refund", "void", "cancel"])
        if kind == "invoice":
            sale = helpers.invoice_cmd(
                cid,
                [(v, rng.randint(1, 5), rng.choice([333, 900, 1250]))],
                discount=rng.choice([0, 0, 100]),
                paid=rng.choice([0, 500, 3000]),
                issued_at=day,
            )
            if helpers.push_one(api, sale)["status"] == "applied":
                invoices.append(sale)
                left[sale["payload"]["invoice_id"]] = [x["qty"] for x in sale["payload"]["lines"]]
                if sale["payload"].get("payment"):
                    money.append(sale["payload"]["payment"]["payment_id"])
        elif kind == "return" and invoices:
            target = rng.choice(invoices)
            remaining = left[target["payload"]["invoice_id"]]
            if remaining[0]:
                qty = rng.randint(1, remaining[0])
                result = helpers.push_one(
                    api,
                    helpers.return_cmd(
                        target, [(0, qty, rng.choice(["restock", "damaged"]))], issued_at=day
                    ),
                )
                if result["status"] == "applied":
                    remaining[0] -= qty
        elif kind == "payment":
            pay = helpers.payment_cmd(cid, rng.choice([400, 1000, 8000]), paid_at=day)
            helpers.push_one(api, pay)
            money.append(pay["payload"]["payment_id"])
        elif kind == "refund":
            refund = helpers.refund_cmd(cid, rng.choice([400, 1000, 3000]), refunded_at=day)
            helpers.push_one(api, refund)
            money.append(refund["payload"]["refund_id"])
        elif kind == "void" and money:
            helpers.push_one(api, helpers.void_cmd(rng.choice(money)))
        elif kind == "cancel" and invoices:
            target = rng.choice(invoices)
            helpers.push_one(
                api,
                helpers.command(
                    "invoice.cancel",
                    {
                        "invoice_id": target["payload"]["invoice_id"],
                        "cancelled_at": day,
                        "reason": "خطأ",
                        "void_payment": rng.choice([True, False]),
                    },
                ),
            )
    return cid


@pytest.mark.parametrize("seed", range(12))
def test_statement_closing_equals_the_balance_formula_with_refunds(
    api: TestClient, db: Session, seed: int
) -> None:
    cid = _random_history(api, seed)
    customer_id = uuid.UUID(cid)
    stmt = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31))
    assert stmt.closing == customers.balance_of(db, customer_id)
    assert stmt.closing == _balance(api, cid)
    running = stmt.rows[0].balance
    for row in stmt.rows[1:]:
        running += row.debit - row.credit
        assert row.balance == running
    assert running == stmt.closing
    assert stmt.total_debit - stmt.total_credit == stmt.closing - stmt.rows[0].balance
    # the formula written out again from the rows in the database
    rows = db.scalars(select(Payment).where(Payment.customer_id == customer_id)).all()
    received = sum(p.amount for p in rows if p.status == "active" and p.kind == "payment")
    given_back = sum(p.amount for p in rows if p.status == "active" and p.kind == "refund")
    from app.models import Invoice, Return

    owed = sum(
        i.total
        for i in db.scalars(select(Invoice).where(Invoice.customer_id == customer_id))
        if i.status == "confirmed"
    )
    credited = sum(
        r.total for r in db.scalars(select(Return).where(Return.customer_id == customer_id))
    )
    opening = db.get(Customer, customer_id)
    assert opening is not None
    assert stmt.closing == opening.opening_balance + owed - credited - received + given_back
    with_off = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31), True)
    assert with_off.closing == stmt.closing

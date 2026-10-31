import random
import uuid
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Payment
from app.services import customers, statement
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


# --- payment.create ---------------------------------------------------------------------------


def test_a_payment_with_no_invoice_lowers_the_balance_and_can_leave_credit(api: TestClient) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    first = helpers.push_one(api, helpers.payment_cmd(cid, 4000))
    assert first["status"] == "applied"
    assert first["data"]["customer_balance"] == 6000
    helpers.push_one(api, helpers.payment_cmd(cid, 9000, method="transfer"))
    assert _balance(api, cid) == -3000  # overpaying is allowed: he has credit


def test_the_payment_row_is_not_linked_to_an_invoice(api: TestClient, db: Session) -> None:
    cid = helpers.customer(api)
    cmd = helpers.payment_cmd(cid, 2500, note="دفعة قديمة")
    helpers.push_one(api, cmd)
    row = db.get(Payment, uuid.UUID(cmd["payload"]["payment_id"]))
    assert row is not None
    assert (row.invoice_id, row.amount, row.status, row.note) == (
        None,
        2500,
        "active",
        "دفعة قديمة",
    )
    pulled = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]["payments"]
    assert [p["id"] for p in pulled] == [str(row.id)]


def test_a_stopped_customer_can_still_pay(api: TestClient) -> None:
    cid = helpers.customer(api, opening_balance=5000)
    helpers.push_one(api, helpers.customer_cmd(cid, is_active=False))
    assert helpers.push_one(api, helpers.payment_cmd(cid, 5000))["status"] == "applied"
    assert _balance(api, cid) == 0


def test_a_payment_needs_an_amount_a_known_customer_and_a_cheque_note(api: TestClient) -> None:
    cid = helpers.customer(api)
    assert _code(helpers.push_one(api, helpers.payment_cmd(cid, 0))) == "VALIDATION_ERROR"
    assert _code(helpers.push_one(api, helpers.payment_cmd(cid, -5))) == "VALIDATION_ERROR"
    cheque = helpers.payment_cmd(cid, 100, method="cheque")
    assert _code(helpers.push_one(api, cheque)) == "VALIDATION_ERROR"
    ok = helpers.push_one(api, helpers.payment_cmd(cid, 100, method="cheque", note="شيك 123"))
    assert ok["status"] == "applied"
    unknown = helpers.payment_cmd(str(uuid.uuid4()), 100)
    assert _code(helpers.push_one(api, unknown)) == "CUSTOMER_NOT_FOUND"


def test_a_payment_number_is_used_once_and_the_same_command_twice_pays_once(
    api: TestClient,
) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    cmd = helpers.payment_cmd(cid, 3000)
    assert helpers.push_one(api, cmd)["status"] == "applied"
    again = helpers.push_one(api, cmd)  # the same command id: replayed, not applied again
    assert again["status"] == "applied"
    assert _balance(api, cid) == 7000
    clash = helpers.payment_cmd(cid, 1000, number=cmd["payload"]["number"])
    assert _code(helpers.push_one(api, clash)) == "DUPLICATE_NUMBER"
    assert _balance(api, cid) == 7000  # a refused command leaves nothing behind


def test_payment_numbers_must_look_like_receipts(api: TestClient) -> None:
    cid = helpers.customer(api)
    bad = helpers.payment_cmd(cid, 100, number="INV-000009")
    assert _code(helpers.push_one(api, bad)) == "VALIDATION_ERROR"


def test_a_payment_is_stored_with_the_device_time(api: TestClient, db: Session) -> None:
    cid = helpers.customer(api)
    cmd = helpers.payment_cmd(cid, 100, paid_at="2026-11-03T10:15:00Z")
    helpers.push_one(api, cmd)
    row = db.get(Payment, uuid.UUID(cmd["payload"]["payment_id"]))
    assert row is not None
    assert row.paid_at == datetime(2026, 11, 3, 10, 15, tzinfo=UTC)


# --- payment.void -----------------------------------------------------------------------------


def test_voiding_gives_the_money_back_to_the_balance_and_keeps_the_record(
    api: TestClient, db: Session
) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    pay = helpers.payment_cmd(cid, 4000)
    helpers.push_one(api, pay)
    pid = pay["payload"]["payment_id"]
    result = helpers.push_one(api, helpers.void_cmd(pid, "كتبتها لزبون ثاني"))
    assert result["status"] == "applied"
    assert result["data"]["customer_balance"] == 10000
    row = db.get(Payment, uuid.UUID(pid))
    assert row is not None
    db.refresh(row)
    assert (row.status, row.void_reason, row.amount) == ("voided", "كتبتها لزبون ثاني", 4000)
    pulled = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]["payments"]
    assert [(p["id"], p["status"]) for p in pulled] == [(pid, "voided")]
    actions = db.scalars(select(AuditLog.action).where(AuditLog.entity == "payment")).all()
    assert sorted(actions) == ["create", "void"]


def test_voiding_twice_is_a_warning_not_a_second_refund(api: TestClient) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    pay = helpers.payment_cmd(cid, 4000)
    helpers.push_one(api, pay)
    pid = pay["payload"]["payment_id"]
    helpers.push_one(api, helpers.void_cmd(pid))
    second = helpers.push_one(api, helpers.void_cmd(pid))  # a new command for the same payment
    assert second["status"] == "applied"
    assert [w["code"] for w in second["warnings"]] == ["ALREADY_VOIDED"]
    assert _balance(api, cid) == 10000


def test_voiding_needs_a_reason_and_a_real_payment(api: TestClient) -> None:
    cid = helpers.customer(api)
    pay = helpers.payment_cmd(cid, 100)
    helpers.push_one(api, pay)
    blank = helpers.void_cmd(pay["payload"]["payment_id"], reason="  ")
    assert _code(helpers.push_one(api, blank)) == "VALIDATION_ERROR"
    assert _code(helpers.push_one(api, helpers.void_cmd(str(uuid.uuid4())))) == "PAYMENT_NOT_FOUND"


def test_a_payment_taken_at_checkout_can_be_voided_too(api: TestClient) -> None:
    cid = helpers.customer(api)
    v = _variant(api)
    sale = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=1500)
    helpers.push_one(api, sale)
    assert _balance(api, cid) == 500
    helpers.push_one(api, helpers.void_cmd(sale["payload"]["payment"]["payment_id"]))
    assert _balance(api, cid) == 2000


def test_cancelling_with_void_after_a_manual_void_does_not_refund_twice(api: TestClient) -> None:
    cid = helpers.customer(api)
    v = _variant(api)
    sale = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=1500)
    helpers.push_one(api, sale)
    helpers.push_one(api, helpers.void_cmd(sale["payload"]["payment"]["payment_id"]))
    cancel = helpers.command(
        "invoice.cancel",
        {
            "invoice_id": sale["payload"]["invoice_id"],
            "cancelled_at": "2026-11-03T12:00:00Z",
            "reason": "خطأ",
            "void_payment": True,
            "lines": [],
        },
    )
    helpers.push_one(api, cancel)
    assert _balance(api, cid) == 0  # nothing owed: invoice cancelled, payment already voided


# --- the balance formula and the statement ----------------------------------------------------


def _random_history(api: TestClient, seed: int) -> str:
    """A customer with invoices, payments, voids and cancellations in a random order."""
    rng = random.Random(seed)
    cid = helpers.customer(api, f"زبون {seed}", opening_balance=rng.choice([0, 7500, -2500]))
    v = _variant(api, stock=500)
    invoices: list[dict[str, Any]] = []
    payment_ids: list[str] = []
    for step in range(rng.randint(6, 14)):
        day = f"2026-11-{3 + step // 2:02d}T{9 + step % 8:02d}:00:00Z"
        kind = rng.choice(["invoice", "invoice", "payment", "payment", "void", "cancel"])
        if kind == "invoice":
            sale = helpers.invoice_cmd(
                cid,
                [(v, rng.randint(1, 4), rng.choice([900, 1250, 4500]))],
                paid=rng.choice([0, 0, 500, 3000]),
                issued_at=day,
            )
            helpers.push_one(api, sale)
            invoices.append(sale)
            if sale["payload"].get("payment"):
                payment_ids.append(sale["payload"]["payment"]["payment_id"])
        elif kind == "payment":
            pay = helpers.payment_cmd(cid, rng.choice([400, 1000, 8000]), paid_at=day)
            helpers.push_one(api, pay)
            payment_ids.append(pay["payload"]["payment_id"])
        elif kind == "void" and payment_ids:
            helpers.push_one(api, helpers.void_cmd(rng.choice(payment_ids)))
        elif kind == "cancel" and invoices:
            target = rng.choice(invoices)
            cancel = helpers.command(
                "invoice.cancel",
                {
                    "invoice_id": target["payload"]["invoice_id"],
                    "cancelled_at": day,
                    "reason": "خطأ",
                    "void_payment": rng.choice([True, False]),
                    "lines": [],
                },
            )
            helpers.push_one(api, cancel)
    return cid


@pytest.mark.parametrize("seed", range(12))
def test_statement_closing_equals_the_balance_formula(
    api: TestClient, db: Session, seed: int
) -> None:
    cid = _random_history(api, seed)
    customer_id = uuid.UUID(cid)
    stmt = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31))
    assert stmt.closing == customers.balance_of(db, customer_id)
    assert stmt.closing == _balance(api, cid)
    # the running balance is carried row by row and only counted rows move it
    running = stmt.rows[0].balance
    for row in stmt.rows[1:]:
        running += row.debit - row.credit
        assert row.balance == running
    assert running == stmt.closing
    assert stmt.total_debit - stmt.total_credit == stmt.closing - stmt.rows[0].balance
    # with the toggle on, the same closing: cancelled and voided rows are shown, never counted
    shown = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31), True)
    assert shown.closing == stmt.closing
    assert len(shown.rows) >= len(stmt.rows)


def test_the_statement_lists_a_standalone_payment_and_a_voided_one_only_when_asked(
    api: TestClient, db: Session
) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    keep = helpers.payment_cmd(cid, 3000, paid_at="2026-11-04T10:00:00Z")
    gone = helpers.payment_cmd(cid, 1000, paid_at="2026-11-05T10:00:00Z")
    helpers.push_one(api, keep)
    helpers.push_one(api, gone)
    helpers.push_one(api, helpers.void_cmd(gone["payload"]["payment_id"]))
    uid = uuid.UUID(cid)
    plain = statement.build(db, uid, date(2026, 11, 1), date(2026, 11, 30))
    assert [r.kind for r in plain.rows] == ["opening", "payment"]
    assert plain.closing == 7000
    full = statement.build(db, uid, date(2026, 11, 1), date(2026, 11, 30), True)
    assert [(r.kind, r.off) for r in full.rows] == [
        ("opening", None),
        ("payment", None),
        ("payment", "voided"),
    ]
    assert full.closing == 7000


def test_an_old_payment_before_the_period_moves_the_opening_balance(
    api: TestClient, db: Session
) -> None:
    cid = helpers.customer(api, opening_balance=10000)
    helpers.push_one(api, helpers.payment_cmd(cid, 4000, paid_at="2026-09-01T10:00:00Z"))
    stmt = statement.build(db, uuid.UUID(cid), date(2026, 10, 1), date(2026, 11, 30))
    assert stmt.rows[0].balance == 6000 and stmt.closing == 6000

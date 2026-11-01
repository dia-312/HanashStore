import random
import uuid
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, Customer, Return, ReturnLine, StockMovement
from app.services import billing, customers, documents, statement
from tests import helpers

V1 = "/api/v1"


def _variant(api: TestClient, price: int = 4500, stock: int = 50) -> str:
    p = helpers.product(api)
    return str(helpers.variant(api, p["id"], price, opening_qty=stock)["id"])


def _stock(api: TestClient, variant_id: str) -> int:
    rows = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]["variants"]
    return int(next(v["stock_qty"] for v in rows if v["id"] == variant_id))


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


def _sale(
    api: TestClient, lines: list[tuple[str, int, int]], **extra: Any
) -> tuple[str, dict[str, Any]]:
    cid = extra.pop("customer_id", None) or helpers.customer(api)
    sale = helpers.invoice_cmd(cid, lines, **extra)
    assert helpers.push_one(api, sale)["status"] == "applied"
    return cid, sale


# --- the credit rule ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("line_total", "discount_share", "sold", "picks", "amounts"),
    [
        (9000, 0, 2, [1, 1], [4500, 4500]),
        (9000, 1000, 2, [1, 1], [4000, 4000]),
        (10000, 3333, 3, [1, 1, 1], [2222, 2222, 2223]),  # the last one takes the rest
        (100, 1, 3, [2, 1], [66, 33]),
        (100, 1, 3, [3], [99]),
        (1, 0, 1, [1], [1]),
        (5000, 5000, 4, [1, 2, 1], [0, 0, 0]),  # a fully discounted line is credited nothing
    ],
)
def test_partial_returns_of_a_line_add_up_to_its_value(
    line_total: int, discount_share: int, sold: int, picks: list[int], amounts: list[int]
) -> None:
    done_qty = done_amount = 0
    got = []
    for qty in picks:
        amount = billing.return_line_amount(
            line_total, discount_share, sold, done_qty, done_amount, qty
        )
        got.append(amount)
        done_qty += qty
        done_amount += amount
    assert got == amounts
    assert sum(got) == line_total - discount_share


def test_the_credit_rule_refuses_more_than_what_is_left() -> None:
    with pytest.raises(ValueError):
        billing.return_line_amount(9000, 0, 2, 1, 4500, 2)
    with pytest.raises(ValueError):
        billing.return_line_amount(9000, 0, 2, 0, 0, 0)


def test_the_credit_rule_matches_the_shared_cases() -> None:
    import json
    from pathlib import Path

    cases = json.loads(
        (Path(__file__).resolve().parents[3] / "shared" / "billing_cases.json").read_text(
            encoding="utf-8"
        )
    )["returns"]
    assert cases
    for case in cases:
        done_qty = done_amount = 0
        for qty, expected in zip(case["picks"], case["amounts"], strict=True):
            amount = billing.return_line_amount(
                case["line_total"], case["discount_share"], case["sold"], done_qty, done_amount, qty
            )
            assert amount == expected, case
            done_qty += qty
            done_amount += amount


def test_random_partitions_always_credit_exactly_the_line_value() -> None:
    rng = random.Random(7)
    for _ in range(2000):
        sold = rng.randint(1, 40)
        line_total = sold * rng.randint(1, 20000)
        share = rng.randint(0, line_total)
        left, done_qty, done_amount = sold, 0, 0
        while left:
            qty = rng.randint(1, left)
            amount = billing.return_line_amount(line_total, share, sold, done_qty, done_amount, qty)
            assert amount >= 0
            done_qty, done_amount, left = done_qty + qty, done_amount + amount, left - qty
        assert done_amount == line_total - share


# --- return.create ------------------------------------------------------------------------------


def test_a_return_credits_the_customer_and_puts_restocked_goods_back(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 2500)], paid=3000)  # 10,000 total, 3,000 paid, 7,000 owed
    assert _stock(api, v) == 6
    cmd = helpers.return_cmd(sale, [(0, 2, "restock")])
    data = _applied(helpers.push_one(api, cmd))
    assert data["total"] == 5000
    assert data["customer_balance"] == 2000
    assert _balance(api, cid) == 2000
    assert _stock(api, v) == 8
    assert data["variants"][0]["stock_qty"] == 8
    line_id = cmd["payload"]["lines"][0]["return_line_id"]
    assert data["amounts"] == {line_id: 5000}
    movement = db.scalars(select(StockMovement).where(StockMovement.type == "return")).one()
    assert (movement.qty, movement.ref_type, str(movement.ref_id)) == (
        2,
        "return",
        cmd["payload"]["return_id"],
    )


def test_damaged_goods_credit_the_customer_but_not_the_shelf(api: TestClient, db: Session) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 2500)])
    data = _applied(helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "damaged")])))
    assert data["total"] == 2500
    assert _balance(api, cid) == 10000 - 2500
    assert _stock(api, v) == 6  # unchanged
    assert db.scalars(select(StockMovement).where(StockMovement.type == "return")).all() == []
    line = db.scalars(select(ReturnLine)).one()
    assert (line.disposition, line.qty, line.amount) == ("damaged", 1, 2500)


def test_one_return_can_mix_lines_and_dispositions(api: TestClient) -> None:
    a, b = _variant(api, stock=10), _variant(api, stock=10)
    cid, sale = _sale(api, [(a, 2, 1000), (b, 3, 2000)], discount=800)  # 8,000 - 800
    data = _applied(
        helpers.push_one(api, helpers.return_cmd(sale, [(0, 2, "restock"), (1, 1, "damaged")]))
    )
    # shares of the 800 discount: 200 and 600 -> line one is worth 1,800, line two 5,400
    assert list(data["amounts"].values()) == [1800, 1800]
    assert data["total"] == 3600
    assert (_stock(api, a), _stock(api, b)) == (10, 7)
    assert _balance(api, cid) == 7200 - 3600


def test_returning_every_line_of_a_discounted_invoice_in_parts_credits_exactly_its_total(
    api: TestClient, db: Session
) -> None:
    """SPEC milestone 7, done when."""
    a, b, c = (_variant(api, stock=100) for _ in range(3))
    cid, sale = _sale(
        api,
        [(a, 7, 333), (b, 3, 1000), (c, 5, 199)],
        discount=777,
        paid=1000,
    )
    invoice_total = 7 * 333 + 3 * 1000 + 5 * 199 - 777
    plan = [
        [(0, 3, "restock"), (1, 1, "damaged")],
        [(0, 1, "restock"), (2, 2, "restock"), (1, 1, "restock")],
        [(0, 3, "damaged"), (1, 1, "restock"), (2, 3, "damaged")],
    ]
    credited = 0
    for picks in plan:
        credited += _applied(helpers.push_one(api, helpers.return_cmd(sale, picks)))["total"]
    assert credited == invoice_total
    assert _balance(api, cid) == invoice_total - 1000 - credited  # = the 1,000 paid is credit
    # everything is back: nothing more to return on any line
    again = helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")]))
    assert _code(again) == "QTY_EXCEEDS_SOLD"
    # and per line the returns add up to the line's net value
    for line in sale["payload"]["lines"]:
        rows = db.scalars(
            select(ReturnLine).where(ReturnLine.invoice_line_id == uuid.UUID(line["line_id"]))
        ).all()
        assert sum(r.qty for r in rows) == line["qty"]


def test_the_server_works_out_the_amount_itself(api: TestClient) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 2, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 1, "restock")])
    cmd["payload"]["total"] = 999999
    cmd["payload"]["lines"][0]["amount"] = 999999
    assert _applied(helpers.push_one(api, cmd))["total"] == 1000


# --- refusals leave nothing behind --------------------------------------------------------------


def test_more_than_what_is_left_on_a_line_is_refused(api: TestClient, db: Session) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 3, 1000)])
    _applied(helpers.push_one(api, helpers.return_cmd(sale, [(0, 2, "restock")])))
    refused = helpers.push_one(api, helpers.return_cmd(sale, [(0, 2, "restock")]))
    assert _code(refused) == "QTY_EXCEEDS_SOLD"
    assert refused["error"]["details"]["already_returned"] == 2
    assert db.scalars(select(Return)).all().__len__() == 1
    assert _balance(api, cid) == 3000 - 2000
    assert _stock(api, v) == 7 + 2


def test_a_refused_return_changes_no_stock_even_if_an_earlier_line_was_fine(
    api: TestClient,
) -> None:
    a, b = _variant(api, stock=10), _variant(api, stock=10)
    cid, sale = _sale(api, [(a, 2, 1000), (b, 1, 1000)])
    refused = helpers.push_one(
        api, helpers.return_cmd(sale, [(0, 2, "restock"), (1, 5, "restock")])
    )
    assert _code(refused) == "QTY_EXCEEDS_SOLD"
    assert _stock(api, a) == 8
    assert _balance(api, cid) == 3000


def test_a_line_of_another_invoice_is_refused(api: TestClient) -> None:
    v = _variant(api, stock=10)
    cid, first = _sale(api, [(v, 1, 1000)])
    _, second = _sale(api, [(v, 1, 1000)], customer_id=cid)
    cmd = helpers.return_cmd(first, [(0, 1, "restock")])
    cmd["payload"]["lines"][0]["invoice_line_id"] = second["payload"]["lines"][0]["line_id"]
    assert _code(helpers.push_one(api, cmd)) == "LINE_NOT_ON_INVOICE"


def test_the_same_line_twice_in_one_return_is_refused(api: TestClient) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 4, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 1, "restock"), (0, 1, "damaged")])
    assert _code(helpers.push_one(api, cmd)) == "VALIDATION_ERROR"


def test_nothing_can_be_returned_from_a_cancelled_invoice(api: TestClient) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 2, 1000)])
    cancel = helpers.command(
        "invoice.cancel",
        {
            "invoice_id": sale["payload"]["invoice_id"],
            "cancelled_at": "2026-11-03T10:00:00Z",
            "reason": "خطأ",
        },
    )
    assert helpers.push_one(api, cancel)["status"] == "applied"
    refused = helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")]))
    assert _code(refused) == "INVOICE_CANCELLED"


def test_an_unknown_invoice_is_refused(api: TestClient) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 2, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 1, "restock")])
    cmd["payload"]["invoice_id"] = str(uuid.uuid4())
    assert _code(helpers.push_one(api, cmd)) == "INVOICE_NOT_FOUND"


def test_an_invoice_with_a_return_can_no_longer_be_cancelled(api: TestClient) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 2, 1000)])
    _applied(helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")])))
    cancel = helpers.command(
        "invoice.cancel",
        {
            "invoice_id": sale["payload"]["invoice_id"],
            "cancelled_at": "2026-11-05T10:00:00Z",
            "reason": "خطأ",
        },
    )
    assert _code(helpers.push_one(api, cancel)) == "HAS_RETURNS"
    assert _balance(api, cid) == 1000


@pytest.mark.parametrize(
    "edit",
    [
        lambda p: p.update(number="INV-000001"),
        lambda p: p.update(lines=[]),
        lambda p: p["lines"][0].update(qty=0),
        lambda p: p["lines"][0].update(disposition="gone"),
        lambda p: p.update(reason="x" * 501),
    ],
)
def test_bad_input_is_a_validation_error(api: TestClient, edit: Any) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 2, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 1, "restock")])
    edit(cmd["payload"])
    assert _code(helpers.push_one(api, cmd)) == "VALIDATION_ERROR"


def test_a_reused_return_number_is_refused_and_nothing_is_written(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 1000)])
    first = helpers.return_cmd(sale, [(0, 1, "restock")])
    _applied(helpers.push_one(api, first))
    second = helpers.return_cmd(sale, [(0, 1, "restock")], number=first["payload"]["number"])
    refused = helpers.push_one(api, second)
    assert _code(refused) == "DUPLICATE_NUMBER"
    assert db.scalars(select(Return)).all().__len__() == 1
    assert _balance(api, cid) == 3000


def test_sending_the_same_command_again_changes_nothing(api: TestClient, db: Session) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 2, "restock")])
    first = helpers.push_one(api, cmd)
    again = helpers.push_one(api, cmd)
    assert again == first
    assert db.scalars(select(Return)).all().__len__() == 1
    assert _balance(api, cid) == 2000
    assert _stock(api, v) == 8


def test_a_stopped_customer_can_still_bring_goods_back(api: TestClient) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 2, 1000)])
    upsert = helpers.customer_cmd(name="محل النور", is_active=False)
    upsert["payload"]["customer_id"] = cid
    helpers.push_one(api, upsert)
    assert _applied(helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")])))


# --- sync, numbers, audit ------------------------------------------------------------------------


def test_returns_and_their_lines_reach_the_device_by_pull(api: TestClient) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 3, "restock")])
    _applied(helpers.push_one(api, cmd))
    changes = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]
    assert [r["id"] for r in changes["returns"]] == [cmd["payload"]["return_id"]]
    ret = changes["returns"][0]
    assert (ret["number"], ret["total"], ret["customer_id"]) == (
        cmd["payload"]["number"],
        3000,
        cid,
    )
    assert [(r["qty"], r["amount"], r["disposition"]) for r in changes["return_lines"]] == [
        (3, 3000, "restock")
    ]
    # the customer row moved too, so the device pulls his new balance
    assert next(c for c in changes["customers"] if c["id"] == cid)["balance"] == 1000


def test_the_numbers_endpoint_knows_the_highest_return_number(api: TestClient) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 4, 1000)])
    _applied(
        helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "restock")], number="RET-000007"))
    )
    assert api.get(V1 + "/sync/numbers").json()["RET"] == 7


def test_a_return_leaves_an_audit_row(api: TestClient, db: Session) -> None:
    v = _variant(api, stock=10)
    _, sale = _sale(api, [(v, 4, 1000)])
    cmd = helpers.return_cmd(sale, [(0, 1, "restock")])
    _applied(helpers.push_one(api, cmd))
    row = db.scalars(select(AuditLog).where(AuditLog.entity == "return")).one()
    assert row.action == "create"
    assert row.after is not None
    assert row.after["total"] == 1000


# --- the statement and the balance formula --------------------------------------------------------


def test_the_statement_shows_returns_as_credit(api: TestClient, db: Session) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 1000)], issued_at="2026-11-02T09:00:00Z")
    _applied(
        helpers.push_one(
            api,
            helpers.return_cmd(sale, [(0, 1, "restock")], issued_at="2026-11-04T09:00:00Z"),
        )
    )
    stmt = statement.build(db, uuid.UUID(cid), date(2026, 11, 1), date(2026, 11, 30))
    kinds = [(r.kind, r.debit, r.credit, r.balance) for r in stmt.rows]
    assert kinds == [
        ("opening", 0, 0, 0),
        ("invoice", 4000, 0, 4000),
        ("return", 0, 1000, 3000),
    ]
    assert stmt.closing == 3000
    # a later period starts from the balance with the return already taken off
    later = statement.build(db, uuid.UUID(cid), date(2026, 11, 10), date(2026, 11, 30))
    assert later.rows[0].balance == 3000


def test_the_statement_document_labels_a_return_and_puts_it_in_the_credit_column(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, stock=10)
    cid, sale = _sale(api, [(v, 4, 1000)], issued_at="2026-11-02T09:00:00Z")
    cmd = helpers.return_cmd(sale, [(0, 1, "restock")], issued_at="2026-11-04T09:00:00Z")
    _applied(helpers.push_one(api, cmd))
    start, end = date(2026, 11, 1), date(2026, 11, 30)
    data = statement.build(db, uuid.UUID(cid), start, end)
    customer = db.get(Customer, uuid.UUID(cid))
    assert customer is not None
    doc = documents.statement_document(db, customer, data, start, end)
    row = doc["rows"][-1]
    assert (row["label"], row["number"], row["debit"], row["credit"], row["balance"]) == (
        "مرتجع",
        cmd["payload"]["number"],
        None,
        "₪ 10.00",
        "₪ 30.00",
    )


def _random_history(api: TestClient, seed: int) -> str:
    """Invoices, payments, voids, cancellations and partial returns in a random order."""
    rng = random.Random(seed)
    cid = helpers.customer(api, f"زبون {seed}", opening_balance=rng.choice([0, 7500, -2500]))
    v = _variant(api, stock=1000)
    invoices: list[dict[str, Any]] = []
    left: dict[str, list[int]] = {}
    payment_ids: list[str] = []
    for step in range(rng.randint(8, 16)):
        day = f"2026-11-{3 + step // 2:02d}T{9 + step % 8:02d}:00:00Z"
        kind = rng.choice(["invoice", "invoice", "return", "return", "payment", "void", "cancel"])
        if kind == "invoice":
            sale = helpers.invoice_cmd(
                cid,
                [(v, rng.randint(1, 5), rng.choice([333, 900, 1250])), (v, 2, 199)],
                discount=rng.choice([0, 0, 100, 777]),
                paid=rng.choice([0, 0, 500, 3000]),
                issued_at=day,
            )
            if helpers.push_one(api, sale)["status"] == "applied":
                invoices.append(sale)
                left[sale["payload"]["invoice_id"]] = [x["qty"] for x in sale["payload"]["lines"]]
                if sale["payload"].get("payment"):
                    payment_ids.append(sale["payload"]["payment"]["payment_id"])
        elif kind == "return" and invoices:
            target = rng.choice(invoices)
            remaining = left[target["payload"]["invoice_id"]]
            picks = []
            for index, qty_left in enumerate(remaining):
                if qty_left and rng.random() < 0.7:
                    picks.append(
                        (index, rng.randint(1, qty_left), rng.choice(["restock", "damaged"]))
                    )
            if picks:
                result = helpers.push_one(api, helpers.return_cmd(target, picks, issued_at=day))
                if result["status"] == "applied":
                    for index, qty, _ in picks:
                        remaining[index] -= qty
        elif kind == "payment":
            pay = helpers.payment_cmd(cid, rng.choice([400, 1000, 8000]), paid_at=day)
            helpers.push_one(api, pay)
            payment_ids.append(pay["payload"]["payment_id"])
        elif kind == "void" and payment_ids:
            helpers.push_one(api, helpers.void_cmd(rng.choice(payment_ids)))
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
def test_statement_closing_equals_the_balance_formula_with_returns(
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
    # the formula written out again from the rows themselves
    opening = int(
        customers.balances(db, [customer_id])[customer_id] - stmt.closing + stmt.rows[0].balance
    )
    assert opening == stmt.rows[0].balance
    # every line's returns never exceed what was sold, and never credit more than its value
    from app.models import InvoiceLine

    for line in db.scalars(select(InvoiceLine)):
        parts = db.scalars(select(ReturnLine).where(ReturnLine.invoice_line_id == line.id)).all()
        assert sum(p.qty for p in parts) <= line.qty
        assert sum(p.amount for p in parts) <= line.line_total - line.discount_share
        if sum(p.qty for p in parts) == line.qty:
            assert sum(p.amount for p in parts) == line.line_total - line.discount_share
    # and with the toggle on, the same closing
    with_off = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31), True)
    assert with_off.closing == stmt.closing

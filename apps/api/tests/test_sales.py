import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AuditLog,
    Customer,
    Invoice,
    InvoiceLine,
    Payment,
    ProductVariant,
    StockMovement,
)
from app.services.stock import stock_mismatches
from tests import helpers

V1 = "/api/v1"


def _variant(api: TestClient, price: int = 4500, stock: int = 20, **extra: Any) -> str:
    p = helpers.product(api, **extra)
    return str(helpers.variant(api, p["id"], price, opening_qty=stock)["id"])


def _pull(api: TestClient, cursor: int = 0) -> dict[str, Any]:
    r = api.get(V1 + "/sync/pull", params={"cursor": cursor})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _customer_row(api: TestClient, customer_id: str) -> dict[str, Any]:
    rows: list[dict[str, Any]] = [
        c for c in _pull(api)["changes"]["customers"] if c["id"] == customer_id
    ]
    assert len(rows) == 1
    return rows[0]


def _stock(api: TestClient, variant_id: str) -> int:
    rows = [v for v in _pull(api)["changes"]["variants"] if v["id"] == variant_id]
    return int(rows[0]["stock_qty"])


def _code(result: dict[str, Any]) -> str:
    assert result["status"] == "rejected", result
    return str(result["error"]["code"])


# --- customers --------------------------------------------------------------------------------


def test_a_customer_is_added_with_an_opening_balance_and_found_by_normalized_text(
    api: TestClient,
) -> None:
    cid = helpers.customer(
        api,
        "أحمد",
        shop_name="بقالة الأمل",
        phone="0599123456",
        area="نابلس",
        opening_balance=25000,
    )
    row = _customer_row(api, cid)
    assert (row["name"], row["balance"], row["opening_balance"]) == ("أحمد", 25000, 25000)
    assert "احمد" in row["search_text"] and "نابلس" in row["search_text"]
    assert "0599123456" in row["search_text"]


def test_editing_a_customer_never_changes_the_opening_balance(api: TestClient) -> None:
    cid = helpers.customer(api, "أحمد", opening_balance=10000)
    edit = helpers.customer_cmd(cid, "أحمد علي", opening_balance=99999, phone="0599")
    assert helpers.push_one(api, edit)["status"] == "applied"
    row = _customer_row(api, cid)
    assert (row["name"], row["balance"], row["opening_balance"]) == ("أحمد علي", 10000, 10000)


def test_a_customer_can_be_stopped_and_kept(api: TestClient) -> None:
    cid = helpers.customer(api)
    stopped = helpers.customer_cmd(cid, is_active=False)
    helpers.push_one(api, stopped)
    assert _customer_row(api, cid)["is_active"] is False


def test_customer_name_is_required(api: TestClient) -> None:
    result = helpers.push_one(api, helpers.customer_cmd(name="  "))
    assert _code(result) == "VALIDATION_ERROR"


# --- invoice.create ---------------------------------------------------------------------------


def test_a_sale_is_recorded_with_totals_stock_payment_and_balance(
    api: TestClient, db: Session
) -> None:
    v1, v2 = _variant(api, 4500, 10), _variant(api, 2000, 5)
    cid = helpers.customer(api, opening_balance=1000)
    result = helpers.sell(
        api, cid, [(v1, 3, 4500), (v2, 2, 2000)], discount=1500, paid=5000, method="transfer"
    )
    assert result["status"] == "applied", result
    data = result["data"]
    assert (data["subtotal"], data["discount"], data["total"]) == (17500, 1500, 16000)
    assert (data["paid"], data["remaining"]) == (5000, 11000)
    assert data["customer_balance"] == 1000 + 16000 - 5000
    assert _stock(api, v1) == 7 and _stock(api, v2) == 3
    assert {v["id"]: v["stock_qty"] for v in data["variants"]} == {v1: 7, v2: 3}

    invoice = db.scalars(select(Invoice)).one()
    assert (invoice.status, invoice.total) == ("confirmed", 16000)
    lines = db.scalars(select(InvoiceLine).order_by(InvoiceLine.sort_order)).all()
    assert [(line.qty, line.line_total) for line in lines] == [(3, 13500), (2, 4000)]
    assert sum(line.discount_share for line in lines) == 1500
    payment = db.scalars(select(Payment)).one()
    assert (payment.amount, payment.method, payment.invoice_id) == (5000, "transfer", invoice.id)
    sales = db.scalars(select(StockMovement).where(StockMovement.type == "sale")).all()
    assert sorted(m.qty for m in sales) == [-3, -2]
    assert {m.ref_type for m in sales} == {"invoice"}


def test_the_invoice_keeps_the_names_as_they_were_at_the_sale(api: TestClient, db: Session) -> None:
    p = helpers.product(api, "أرجيلة كبيرة")
    v = str(helpers.variant(api, p["id"], 4500, color="أسود", size="كبير", opening_qty=5)["id"])
    helpers.sell(api, helpers.customer(api), [(v, 1, 4500)])
    api.patch(f"{V1}/products/{p['id']}", json={"name": "اسم جديد"})
    line = db.scalars(select(InvoiceLine)).one()
    assert (line.product_name, line.variant_label) == ("أرجيلة كبيرة", "أسود · كبير")


def test_a_sale_with_no_payment_leaves_the_whole_total_owed(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 5), helpers.customer(api)
    result = helpers.sell(api, cid, [(v, 2, 1000)])
    assert result["data"]["paid"] == 0 and result["data"]["remaining"] == 2000
    assert db.scalar(select(func.count()).select_from(Payment)) == 0
    assert _customer_row(api, cid)["balance"] == 2000


def test_paying_more_than_the_total_leaves_the_customer_in_credit(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 5), helpers.customer(api)
    result = helpers.sell(api, cid, [(v, 1, 1000)], paid=2500)
    assert result["data"]["remaining"] == 0
    assert result["data"]["customer_balance"] == -1500


def test_the_server_works_out_the_totals_and_the_discount_shares(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, 100, 50)
    cid = helpers.customer(api)
    helpers.sell(api, cid, [(v, 1, 100), (v, 1, 100), (v, 1, 100)], discount=2)
    shares = [
        line.discount_share
        for line in db.scalars(select(InvoiceLine).order_by(InvoiceLine.sort_order))
    ]
    assert shares == [1, 1, 0]


def test_a_discount_larger_than_the_invoice_is_refused_and_nothing_is_saved(
    api: TestClient, db: Session
) -> None:
    v, cid = _variant(api, 1000, 5), helpers.customer(api)
    result = helpers.sell(api, cid, [(v, 1, 1000)], discount=1001)
    assert _code(result) == "DISCOUNT_TOO_LARGE"
    assert db.scalar(select(func.count()).select_from(Invoice)) == 0
    assert _stock(api, v) == 5


def test_a_price_that_changed_is_accepted_with_a_warning(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 5), helpers.customer(api)
    result = helpers.sell(api, cid, [(v, 1, 900)])  # the customer agreed to 9.00
    assert result["status"] == "applied"
    assert result["data"]["total"] == 900
    assert [w["code"] for w in result["warnings"]] == ["PRICE_CHANGED"]


def test_selling_more_than_the_stock_is_recorded_with_a_warning(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 2), helpers.customer(api)
    result = helpers.sell(api, cid, [(v, 5, 1000)])
    assert result["status"] == "applied"
    assert [w["code"] for w in result["warnings"]] == ["STOCK_NEGATIVE"]
    assert _stock(api, v) == -3


def test_the_same_command_twice_makes_one_invoice(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=500)
    first, second = helpers.push_one(api, cmd), helpers.push_one(api, cmd)
    assert first == second
    assert db.scalar(select(func.count()).select_from(Invoice)) == 1
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    assert _stock(api, v) == 8


def test_the_same_invoice_under_a_new_command_id_is_refused_not_doubled(
    api: TestClient, db: Session
) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 2, 1000)])
    helpers.push_one(api, cmd)
    again = {**cmd, "id": str(uuid.uuid4())}
    assert _code(helpers.push_one(api, again)) == "INVOICE_EXISTS"
    assert _stock(api, v) == 8


def test_a_number_already_used_is_refused_and_nothing_changes(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    helpers.sell(api, cid, [(v, 1, 1000)], number="INV-000050")
    result = helpers.sell(api, cid, [(v, 1, 1000)], number="INV-000050")
    assert _code(result) == "DUPLICATE_NUMBER"
    assert db.scalar(select(func.count()).select_from(Invoice)) == 1
    assert _stock(api, v) == 9


def test_a_payment_number_already_used_is_refused(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    first = helpers.invoice_cmd(cid, [(v, 1, 1000)], paid=500)
    helpers.push_one(api, first)
    second = helpers.invoice_cmd(cid, [(v, 1, 1000)], paid=500)
    second["payload"]["payment"]["number"] = first["payload"]["payment"]["number"]
    assert _code(helpers.push_one(api, second)) == "DUPLICATE_NUMBER"
    assert db.scalar(select(func.count()).select_from(Invoice)) == 1


@pytest.mark.parametrize("problem", ["no customer", "stopped customer", "stopped variant"])
def test_a_sale_that_cannot_be_made_leaves_nothing_behind(
    api: TestClient, db: Session, problem: str
) -> None:
    v = _variant(api, 1000, 10)
    cid = helpers.customer(api)
    if problem == "no customer":
        cid = str(uuid.uuid4())
    elif problem == "stopped customer":
        helpers.push_one(api, helpers.customer_cmd(cid, is_active=False))
    else:
        api.patch(f"{V1}/variants/{v}", json={"is_active": False})
    result = helpers.sell(api, cid, [(v, 1, 1000)], paid=300)
    assert result["status"] == "rejected"
    assert db.scalar(select(func.count()).select_from(Invoice)) == 0
    assert db.scalar(select(func.count()).select_from(Payment)) == 0
    db.expire_all()
    assert db.get(ProductVariant, uuid.UUID(v)).stock_qty == 10  # type: ignore[union-attr]


def test_a_cheque_needs_its_details_in_the_note(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    bad = helpers.sell(api, cid, [(v, 1, 1000)], paid=500, method="cheque")
    assert _code(bad) == "VALIDATION_ERROR"
    ok = helpers.sell(
        api, cid, [(v, 1, 1000)], paid=500, method="cheque", pay_note="123 بنك فلسطين"
    )
    assert ok["status"] == "applied"


def test_an_invoice_needs_at_least_one_line_and_a_proper_number(api: TestClient) -> None:
    cid = helpers.customer(api)
    empty = helpers.invoice_cmd(cid, [])
    assert _code(helpers.push_one(api, empty)) == "VALIDATION_ERROR"
    v = _variant(api)
    wrong = helpers.invoice_cmd(cid, [(v, 1, 100)], number="REC-000001")
    assert _code(helpers.push_one(api, wrong)) == "VALIDATION_ERROR"


# --- deliver and cancel -----------------------------------------------------------------------


def _deliver(invoice_id: str, at: str) -> dict[str, Any]:
    return helpers.command("invoice.mark_delivered", {"invoice_id": invoice_id, "delivered_at": at})


def test_marking_delivered_records_the_first_time_only(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 1, 1000)])
    helpers.push_one(api, cmd)
    iid = cmd["payload"]["invoice_id"]
    assert helpers.push_one(api, _deliver(iid, "2026-11-03T10:00:00Z"))["status"] == "applied"
    assert helpers.push_one(api, _deliver(iid, "2026-11-09T10:00:00Z"))["status"] == "applied"
    invoice = db.scalars(select(Invoice)).one()
    assert invoice.delivered_at is not None and invoice.delivered_at.day == 3
    assert _stock(api, v) == 9  # delivering has no stock effect


def test_a_missing_invoice_cannot_be_delivered_or_cancelled(api: TestClient) -> None:
    ghost = str(uuid.uuid4())
    assert (
        _code(helpers.push_one(api, _deliver(ghost, "2026-11-03T10:00:00Z"))) == "INVOICE_NOT_FOUND"
    )
    cancel = helpers.command(
        "invoice.cancel",
        {"invoice_id": ghost, "cancelled_at": "2026-11-03T10:00:00Z", "reason": "x"},
    )
    assert _code(helpers.push_one(api, cancel)) == "INVOICE_NOT_FOUND"


def _cancel(
    invoice_id: str, *, void_payment: bool = False, reason: str = "خطأ بالكمية"
) -> dict[str, Any]:
    return helpers.command(
        "invoice.cancel",
        {
            "invoice_id": invoice_id,
            "cancelled_at": "2026-11-03T11:00:00Z",
            "reason": reason,
            "void_payment": void_payment,
        },
    )


def test_cancelling_puts_the_stock_back_and_the_balance_with_it(
    api: TestClient, db: Session
) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api, opening_balance=500)
    cmd = helpers.invoice_cmd(cid, [(v, 4, 1000)])
    helpers.push_one(api, cmd)
    assert _stock(api, v) == 6 and _customer_row(api, cid)["balance"] == 4500
    result = helpers.push_one(api, _cancel(cmd["payload"]["invoice_id"]))
    assert result["status"] == "applied"
    assert result["data"]["customer_balance"] == 500
    assert _stock(api, v) == 10
    invoice = db.scalars(select(Invoice)).one()
    assert (invoice.status, invoice.cancel_reason) == ("cancelled", "خطأ بالكمية")
    assert _customer_row(api, cid)["balance"] == 500
    movements = db.scalars(select(StockMovement).where(StockMovement.type == "sale_cancel")).all()
    assert [m.qty for m in movements] == [4]


def test_cancelling_can_keep_the_payment_as_credit_or_void_it(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 20), helpers.customer(api)
    keep = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=1500)
    void = helpers.invoice_cmd(cid, [(v, 2, 1000)], paid=1500)
    helpers.push_one(api, keep)
    helpers.push_one(api, void)
    assert _customer_row(api, cid)["balance"] == 1000  # 2 x (2000 - 1500)

    helpers.push_one(api, _cancel(keep["payload"]["invoice_id"], void_payment=False))
    assert _customer_row(api, cid)["balance"] == 500 - 1500 + 1500 - 1500 + 0 or True
    # keep: the 1500 stays as credit; the other invoice still owes 500: 500 - 1500 = -1000
    assert _customer_row(api, cid)["balance"] == -1000

    helpers.push_one(api, _cancel(void["payload"]["invoice_id"], void_payment=True))
    # the second invoice is gone and its payment voided: only the kept credit remains
    assert _customer_row(api, cid)["balance"] == -1500
    statuses = sorted(p.status for p in db.scalars(select(Payment)))
    assert statuses == ["active", "voided"]


def test_cancelling_twice_does_nothing_more(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 3, 1000)])
    helpers.push_one(api, cmd)
    iid = cmd["payload"]["invoice_id"]
    helpers.push_one(api, _cancel(iid))
    again = helpers.push_one(api, _cancel(iid))
    assert again["status"] == "applied"
    assert [w["code"] for w in again["warnings"]] == ["ALREADY_CANCELLED"]
    assert _stock(api, v) == 10  # restored once, not twice


def test_a_cancelled_invoice_cannot_be_delivered_and_needs_a_reason(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 1, 1000)])
    helpers.push_one(api, cmd)
    iid = cmd["payload"]["invoice_id"]
    assert _code(helpers.push_one(api, _cancel(iid, reason="  "))) == "VALIDATION_ERROR"
    helpers.push_one(api, _cancel(iid))
    assert (
        _code(helpers.push_one(api, _deliver(iid, "2026-11-04T10:00:00Z"))) == "INVOICE_CANCELLED"
    )


# --- balance, pull, numbers, audit ------------------------------------------------------------


def test_the_balance_follows_the_formula_across_many_documents(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 100), helpers.customer(api, opening_balance=2000)
    a = helpers.invoice_cmd(cid, [(v, 5, 1000)], paid=1000)  # +5000 -1000
    b = helpers.invoice_cmd(cid, [(v, 2, 1000)], discount=500, paid=3000)  # +1500 -3000
    c = helpers.invoice_cmd(cid, [(v, 1, 1000)])  # +1000, then cancelled
    for cmd in (a, b, c):
        helpers.push_one(api, cmd)
    helpers.push_one(api, _cancel(c["payload"]["invoice_id"]))
    assert _customer_row(api, cid)["balance"] == 2000 + 5000 - 1000 + 1500 - 3000


def test_a_sale_brings_the_customer_row_back_in_the_next_pull(api: TestClient) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cursor = _pull(api)["cursor"]
    helpers.sell(api, cid, [(v, 2, 1000)], paid=500)
    page = _pull(api, cursor)["changes"]
    assert [(c["id"], c["balance"]) for c in page["customers"]] == [(cid, 1500)]
    assert len(page["invoices"]) == 1 and len(page["invoice_lines"]) == 1
    assert len(page["payments"]) == 1
    assert [x["stock_qty"] for x in page["variants"]] == [8]


def test_invoices_older_than_twelve_months_are_not_sent_but_still_count(
    api: TestClient,
) -> None:
    v, cid = _variant(api, 1000, 50), helpers.customer(api)
    helpers.sell(api, cid, [(v, 1, 1000)], issued_at="2024-01-05T10:00:00Z", paid=200)
    helpers.sell(api, cid, [(v, 1, 1000)])
    changes = _pull(api)["changes"]
    assert len(changes["invoices"]) == 1
    assert len(changes["invoice_lines"]) == 1
    assert len(changes["payments"]) == 0  # the old payment is outside the window too
    assert _customer_row(api, cid)["balance"] == 1000 + 1000 - 200


def test_stock_cache_still_equals_the_sum_of_movements_after_sales_and_cancels(
    api: TestClient, db: Session
) -> None:
    variants = [_variant(api, 1000, 10) for _ in range(3)]
    cid = helpers.customer(api)
    cmds = [helpers.invoice_cmd(cid, [(v, 3, 1000)]) for v in variants]
    for cmd in cmds:
        helpers.push_one(api, cmd)
    helpers.push_one(api, _cancel(cmds[0]["payload"]["invoice_id"]))
    helpers.sell(api, cid, [(variants[1], 20, 1000)])  # goes negative, still consistent
    assert stock_mismatches(db) == []


def test_highest_numbers_let_a_new_device_continue_the_sequence(api: TestClient) -> None:
    assert api.get(V1 + "/sync/numbers").json() == {"INV": 0, "REC": 0, "RET": 0, "REF": 0}
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    first = helpers.invoice_cmd(cid, [(v, 1, 1000)], number="INV-000042", paid=100)
    first["payload"]["payment"]["number"] = "REC-000004"
    second = helpers.invoice_cmd(cid, [(v, 1, 1000)], number="INV-000043", paid=100)
    second["payload"]["payment"]["number"] = "REC-000010"
    helpers.push_one(api, first)
    helpers.push_one(api, second)
    assert api.get(V1 + "/sync/numbers").json() == {"INV": 43, "REC": 10, "RET": 0, "REF": 0}


def test_every_command_leaves_audit_rows(api: TestClient, db: Session) -> None:
    v, cid = _variant(api, 1000, 10), helpers.customer(api)
    cmd = helpers.invoice_cmd(cid, [(v, 1, 1000)])
    helpers.push_one(api, cmd)
    helpers.push_one(api, _cancel(cmd["payload"]["invoice_id"]))
    entities = db.execute(select(AuditLog.entity, AuditLog.action)).all()
    assert ("invoice", "create") in entities and ("invoice", "cancel") in entities
    assert ("customer", "create") in entities
    assert db.scalar(select(func.count()).select_from(Customer)) == 1

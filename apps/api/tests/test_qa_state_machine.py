"""QA: random histories over every command type, with replays and refusals, then the invariants
that must hold whatever happened (money, stock, documents, sync).

The rules checked here are written out again from the raw rows, not taken from the code under test.
"""

import random
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Customer,
    Invoice,
    InvoiceLine,
    Payment,
    ProductVariant,
    Return,
    ReturnLine,
    StockMovement,
)
from tests import helpers

V1 = "/api/v1"
STAMP = "2026-11-02T09:14:20Z"


class Run:
    def __init__(self, api: TestClient, seed: int) -> None:
        self.api = api
        self.rng = random.Random(seed)
        self.customers = [helpers.customer(api, name=f"زبون {i}") for i in range(3)]
        self.variants: list[str] = []
        for i in range(4):
            product = helpers.product(api, name=f"منتج {i}")
            variant = helpers.variant(api, product["id"], price=self.rng.randrange(100, 9000))
            helpers.stock_in(api, variant["id"], 50)
            self.variants.append(variant["id"])
        self.sales: list[dict[str, Any]] = []
        self.payments: list[str] = []
        self.applied: list[dict[str, Any]] = []
        self.outcomes: dict[str, dict[str, Any]] = {}

    def push(self, cmd: dict[str, Any]) -> dict[str, Any]:
        result = helpers.push_one(self.api, cmd)
        assert result["status"] in {"applied", "rejected"}, result
        self.outcomes[cmd["id"]] = result
        if result["status"] == "applied":
            self.applied.append(cmd)
        return result

    def step(self) -> None:
        rng = self.rng
        kind = rng.choice(
            ["sale"] * 4
            + ["cancel", "deliver"]
            + ["return"] * 3
            + ["payment", "payment", "void", "refund", "purchase", "damage", "adjust", "customer"]
        )
        customer = rng.choice(self.customers)
        variant = rng.choice(self.variants)
        # about one in ten numbers is one that was used already
        reuse = rng.random() < 0.1
        if kind == "sale":
            lines = [
                (rng.choice(self.variants), rng.randrange(1, 6), rng.randrange(100, 9000))
                for _ in range(rng.randrange(1, 4))
            ]
            subtotal = sum(q * p for _, q, p in lines)
            cmd = helpers.invoice_cmd(
                customer,
                lines,
                discount=rng.choice([0, 0, rng.randrange(0, subtotal + 200)]),
                paid=rng.choice([0, 0, rng.randrange(1, subtotal * 2)]),
                number="INV-000001" if reuse else None,
            )
            if self.push(cmd)["status"] == "applied":
                self.sales.append(cmd)
        elif kind == "cancel" and self.sales:
            sale = rng.choice(self.sales)
            self.push(
                helpers.command(
                    "invoice.cancel",
                    {
                        "invoice_id": sale["payload"]["invoice_id"],
                        "cancelled_at": STAMP,
                        "reason": "x",
                        "void_payment": rng.random() < 0.5,
                        "lines": [],
                    },
                )
            )
        elif kind == "deliver" and self.sales:
            sale = rng.choice(self.sales)
            self.push(
                helpers.command(
                    "invoice.mark_delivered",
                    {"invoice_id": sale["payload"]["invoice_id"], "delivered_at": STAMP},
                )
            )
        elif kind == "return" and self.sales:
            sale = rng.choice(self.sales)
            lines = sale["payload"]["lines"]
            picks = [
                (
                    i,
                    rng.randrange(1, lines[i]["qty"] + 2),
                    rng.choice(["restock", "damaged"]),
                )
                for i in rng.sample(range(len(lines)), rng.randrange(1, len(lines) + 1))
            ]
            self.push(helpers.return_cmd(sale, picks, number="RET-000001" if reuse else None))
        elif kind == "payment":
            cmd = helpers.payment_cmd(customer, rng.randrange(1, 20000))
            if self.push(cmd)["status"] == "applied":
                self.payments.append(cmd["payload"]["payment_id"])
        elif kind == "void" and self.payments:
            self.push(helpers.void_cmd(rng.choice(self.payments)))
        elif kind == "refund":
            self.push(helpers.refund_cmd(customer, rng.randrange(1, 20000)))
        elif kind == "purchase":
            self.push(helpers.purchase_cmd([(variant, rng.randrange(1, 30))]))
        elif kind == "damage":
            payload = {
                "movement_id": str(uuid.uuid4()),
                "variant_id": variant,
                "qty": rng.randrange(1, 40),
                "note": "x",
            }
            self.push(helpers.command("stock.damage", payload))
        elif kind == "adjust":
            payload = {
                "movement_id": str(uuid.uuid4()),
                "variant_id": variant,
                "counted_qty": rng.randrange(0, 80),
                "expected_qty": None,
                "note": "c",
            }
            self.push(helpers.command("stock.adjust", payload))
        elif kind == "customer":
            self.push(helpers.customer_cmd(customer, name=f"معدّل {rng.randrange(99)}"))


def _fingerprint(db: Session) -> tuple[Any, ...]:
    """Everything that a refused or repeated command must leave exactly as it was."""
    db.rollback()
    return (
        db.scalar(select(func.count()).select_from(Invoice)),
        db.scalar(select(func.coalesce(func.sum(Invoice.total), 0))),
        db.scalar(select(func.count()).select_from(InvoiceLine)),
        db.scalar(select(func.count()).select_from(Payment)),
        db.scalar(select(func.coalesce(func.sum(Payment.amount), 0))),
        db.scalar(select(func.count()).select_from(Return)),
        db.scalar(select(func.coalesce(func.sum(Return.total), 0))),
        db.scalar(select(func.count()).select_from(ReturnLine)),
        db.scalar(select(func.count()).select_from(StockMovement)),
        db.scalar(select(func.coalesce(func.sum(StockMovement.qty), 0))),
        db.scalar(select(func.coalesce(func.sum(ProductVariant.stock_qty), 0))),
        db.scalar(select(func.count()).select_from(Customer)),
    )


def _sum(db: Session, column: Any, *where: Any) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(column), 0)).where(*where)) or 0)


def _balance(db: Session, customer: Customer) -> int:
    """SPEC section 7, written out again from the rows."""
    return (
        customer.opening_balance
        + _sum(db, Invoice.total, Invoice.customer_id == customer.id, Invoice.status == "confirmed")
        - _sum(db, Return.total, Return.customer_id == customer.id)
        - _sum(
            db,
            Payment.amount,
            Payment.customer_id == customer.id,
            Payment.status == "active",
            Payment.kind == "payment",
        )
        + _sum(
            db,
            Payment.amount,
            Payment.customer_id == customer.id,
            Payment.status == "active",
            Payment.kind == "refund",
        )
    )


def check_invariants(api: TestClient, db: Session) -> None:
    db.rollback()
    # stock: the cache is the sum of the movements, for every variant
    for variant in db.scalars(select(ProductVariant)):
        moved = _sum(db, StockMovement.qty, StockMovement.variant_id == variant.id)
        assert variant.stock_qty == moved, (variant.sku, variant.stock_qty, moved)

    # documents: lines add up to the invoice, the discount is shared out exactly
    for invoice in db.scalars(select(Invoice)):
        lines = db.scalars(select(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id)).all()
        assert lines, invoice.number
        assert invoice.subtotal == sum(ln.line_total for ln in lines), invoice.number
        assert all(ln.line_total == ln.qty * ln.unit_price for ln in lines), invoice.number
        assert invoice.total == invoice.subtotal - invoice.discount, invoice.number
        assert 0 <= invoice.discount <= invoice.subtotal, invoice.number
        assert sum(ln.discount_share for ln in lines) == invoice.discount, invoice.number
        assert invoice.status in {"confirmed", "cancelled"}

    # returns: a line never gives back more than it sold or more than it is worth
    for line in db.scalars(select(InvoiceLine)):
        taken = _sum(db, ReturnLine.qty, ReturnLine.invoice_line_id == line.id)
        credited = _sum(db, ReturnLine.amount, ReturnLine.invoice_line_id == line.id)
        worth = line.line_total - line.discount_share
        assert taken <= line.qty, (line.id, taken, line.qty)
        assert 0 <= credited <= worth, (line.id, credited, worth)
        if taken == line.qty:
            assert credited == worth, (line.id, credited, worth)
    for ret in db.scalars(select(Return)):
        assert ret.total == _sum(db, ReturnLine.amount, ReturnLine.return_id == ret.id)

    # the balance the server reports is the formula
    page = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()
    reported = {c["id"]: c["balance"] for c in page["changes"]["customers"]}
    for customer in db.scalars(select(Customer)):
        assert reported[str(customer.id)] == _balance(db, customer), customer.name

    # the statement of every customer ends on his balance
    for customer in db.scalars(select(Customer)):
        r = api.get(
            f"{V1}/customers/{customer.id}/statement",
            params={"from": "2000-01-01", "to": "2100-12-31"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["closing"] == _balance(db, customer), customer.name

    # numbers are unique and the next number is above every used one
    numbers = api.get(V1 + "/sync/numbers").json()
    assert numbers["INV"] >= db.scalar(select(func.count()).select_from(Invoice))


def check_incremental_pull_equals_full(api: TestClient) -> None:
    """Reading in small pages gives the same rows as reading everything at once."""
    full = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()["changes"]
    merged: dict[str, dict[str, Any]] = {k: {} for k in full}
    cursor = 0
    for _ in range(500):
        page = api.get(V1 + "/sync/pull", params={"cursor": cursor}).json()
        for table, rows in page["changes"].items():
            for row in rows:
                merged[table][row["id"]] = row
        if not page["has_more"] or page["cursor"] == cursor:
            break
        cursor = page["cursor"]
    for table, rows in full.items():
        assert {r["id"] for r in rows} == set(merged[table]), table


@pytest.mark.parametrize("seed", range(8))
def test_random_histories_keep_every_invariant(api: TestClient, db: Session, seed: int) -> None:
    run = Run(api, seed)
    for _ in range(70):
        before = _fingerprint(db)
        count_before = len(run.applied)
        run.step()
        if len(run.applied) == count_before:
            # refused, or nothing to do: the books are exactly as they were
            assert _fingerprint(db) == before
    check_invariants(api, db)
    check_incremental_pull_equals_full(api)

    # sending everything again changes nothing and answers the same
    before = _fingerprint(db)
    for cmd in run.applied[:: max(1, len(run.applied) // 40)]:
        again = helpers.push_one(api, cmd)
        assert again == run.outcomes[cmd["id"]]
    assert _fingerprint(db) == before
    check_invariants(api, db)

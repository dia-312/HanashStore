"""Reports (SPEC F12): fixed cases worked out by hand, the day boundary, the rules around the
period, and random histories checked against a reference written separately from the rows."""

import random
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.models import (
    Invoice,
    InvoiceLine,
    Payment,
    ProductVariant,
    Return,
    ReturnLine,
)
from app.services import reports
from tests import helpers

V1 = "/api/v1/reports"
HEBRON = ZoneInfo("Asia/Hebron")
NOW = datetime(2026, 11, 3, 9, 0, tzinfo=UTC)  # Tuesday 03/11/2026, 11:00 in Hebron


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "utcnow", lambda: NOW)


def get(api: TestClient, path: str, **params: Any) -> dict[str, Any]:
    r = api.get(V1 + path, params=params)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


class Shop:
    """Two products, two customers, and a few days of trade, with the numbers known in advance."""

    def __init__(self, api: TestClient) -> None:
        self.api = api
        self.cat = helpers.category(api, "أراجيل")["id"]
        a = helpers.product(api, "أرجيلة كبيرة", category_id=self.cat)
        b = helpers.product(api, "فحم", category_id=self.cat)
        self.va = helpers.variant(api, a["id"], price=1000, color="أسود", min_stock=5)["id"]
        self.vb = helpers.variant(api, b["id"], price=500, size="25", min_stock=5)["id"]
        helpers.stock_in(api, self.va, 100)
        helpers.stock_in(api, self.vb, 100)
        self.ana = helpers.customer(api, name="أحمد", opening_balance=0)
        self.bob = helpers.customer(api, name="بلال", opening_balance=4000)

        # 30/10: A buys 3 x 10.00 with 1.00 off and pays 10.00 cash;
        # B buys 2 x 5.00 and pays it all by transfer
        self.sale1 = helpers.invoice_cmd(
            self.ana,
            [(self.va, 3, 1000)],
            discount=100,
            paid=1000,
            issued_at="2026-10-30T10:00:00Z",
        )
        self.sale2 = helpers.invoice_cmd(
            self.bob,
            [(self.vb, 2, 500)],
            paid=1000,
            method="transfer",
            issued_at="2026-10-30T11:00:00Z",
        )
        # 31/10: one unit of sale 1 comes back and goes on the shelf; a sale that is cancelled
        self.ret = helpers.return_cmd(
            self.sale1, [(0, 1, "restock")], issued_at="2026-10-31T09:00:00Z"
        )
        self.sale3 = helpers.invoice_cmd(
            self.ana, [(self.va, 1, 1000)], issued_at="2026-10-31T10:00:00Z"
        )
        # 01/11: a payment, a refund, a payment that is voided, a damaged return
        self.pay = helpers.payment_cmd(self.ana, 700, paid_at="2026-11-01T10:00:00Z")
        self.refund = helpers.refund_cmd(self.ana, 200, refunded_at="2026-11-01T11:00:00Z")
        self.voided = helpers.payment_cmd(self.bob, 300, paid_at="2026-11-01T12:00:00Z")
        for cmd in (self.sale1, self.sale2, self.ret, self.sale3):
            assert helpers.push_one(api, cmd)["status"] == "applied"
        cancel = helpers.command(
            "invoice.cancel",
            {
                "invoice_id": self.sale3["payload"]["invoice_id"],
                "cancelled_at": "2026-10-31T10:30:00Z",
                "reason": "x",
                "void_payment": False,
                "lines": [],
            },
        )
        for cmd in (cancel, self.pay, self.refund, self.voided):
            assert helpers.push_one(api, cmd)["status"] == "applied"
        void = helpers.void_cmd(
            self.voided["payload"]["payment_id"], voided_at="2026-11-01T13:00:00Z"
        )
        assert helpers.push_one(api, void)["status"] == "applied"
        # a damaged return on 02/11 and a write-off today
        self.damaged_ret = helpers.return_cmd(
            self.sale2, [(0, 1, "damaged")], issued_at="2026-11-02T09:00:00Z"
        )
        assert helpers.push_one(api, self.damaged_ret)["status"] == "applied"
        assert helpers.damage(api, self.vb, 4, note="سقطت")["status"] == "applied"


def test_sales_by_day_net_of_returns_and_without_cancelled(api: TestClient) -> None:
    Shop(api)
    body = get(api, "/sales", group="day", **{"from": "2026-10-29", "to": "2026-11-03"})
    rows = {r["period"]: r for r in body["rows"]}
    assert list(rows) == [
        "2026-10-29",
        "2026-10-30",
        "2026-10-31",
        "2026-11-01",
        "2026-11-02",
        "2026-11-03",
    ]  # a day with nothing is still there
    # 30/10: sale 1 = 3000 - 100, sale 2 = 1000
    assert (rows["2026-10-30"]["invoices"], rows["2026-10-30"]["gross"]) == (2, 3900)
    # 31/10: the cancelled sale does not count; the return: floor(2900 / 3) = 966
    assert (rows["2026-10-31"]["invoices"], rows["2026-10-31"]["gross"]) == (0, 0)
    assert (rows["2026-10-31"]["returns"], rows["2026-10-31"]["net"]) == (966, -966)
    # 02/11: the damaged return of one of the two 5.00 units
    assert rows["2026-11-02"]["returns"] == 500
    assert rows["2026-10-29"]["net"] == 0
    assert (body["invoices"], body["gross"], body["returns"], body["net"]) == (2, 3900, 1466, 2434)


def test_sales_by_month_and_the_two_groupings_agree(api: TestClient) -> None:
    Shop(api)
    month = get(api, "/sales", group="month", **{"from": "2026-10-01", "to": "2026-11-30"})
    assert [r["period"] for r in month["rows"]] == ["2026-10", "2026-11"]
    october, november = month["rows"]
    assert (october["gross"], october["returns"]) == (3900, 966)
    assert (november["gross"], november["returns"]) == (0, 500)
    day = get(api, "/sales", group="day", **{"from": "2026-10-01", "to": "2026-11-30"})
    assert (day["gross"], day["returns"], day["net"]) == (
        month["gross"],
        month["returns"],
        month["net"],
    )


def test_a_day_is_a_hebron_day_not_a_utc_day(api: TestClient) -> None:
    cid = helpers.customer(api)
    product = helpers.product(api)
    var = helpers.variant(api, product["id"], price=100)["id"]
    helpers.stock_in(api, var, 10)
    # DST ended on 24/10/2026: Hebron is UTC+2. 21:59:59Z is 23:59:59 on the 30th, 22:00:00Z is
    # midnight, the 31st.
    for stamp in ("2026-10-30T21:59:59Z", "2026-10-30T22:00:00Z"):
        assert helpers.sell(api, cid, [(var, 1, 100)], issued_at=stamp)["status"] == "applied"
    rows = {
        r["period"]: r["invoices"]
        for r in get(api, "/sales", **{"from": "2026-10-30", "to": "2026-10-31"})["rows"]
    }
    assert rows == {"2026-10-30": 1, "2026-10-31": 1}
    # and in summer (UTC+3) the boundary is an hour earlier
    for stamp in ("2026-07-14T20:59:59Z", "2026-07-14T21:00:00Z"):
        assert helpers.sell(api, cid, [(var, 1, 100)], issued_at=stamp)["status"] == "applied"
    rows = {
        r["period"]: r["invoices"]
        for r in get(api, "/sales", **{"from": "2026-07-14", "to": "2026-07-15"})["rows"]
    }
    assert rows == {"2026-07-14": 1, "2026-07-15": 1}


def test_products_add_up_to_the_sales_total_exactly(api: TestClient) -> None:
    Shop(api)
    sales = get(api, "/sales", **{"from": "2026-10-29", "to": "2026-11-03"})
    by_product = get(
        api, "/products", by="product", limit=50, **{"from": "2026-10-29", "to": "2026-11-03"}
    )
    by_variant = get(
        api, "/products", by="variant", limit=50, **{"from": "2026-10-29", "to": "2026-11-03"}
    )
    by_category = get(
        api, "/products", by="category", limit=50, **{"from": "2026-10-29", "to": "2026-11-03"}
    )
    assert by_product["amount"] == by_variant["amount"] == by_category["amount"] == sales["net"]
    rows = {r["name"]: r for r in by_product["rows"]}
    # hookah: 3 sold, 1 back = 2 units, 2900 - 966;
    # charcoal: 2 sold, 1 back damaged = 1 unit, 1000 - 500
    assert (rows["أرجيلة كبيرة"]["qty"], rows["أرجيلة كبيرة"]["amount"]) == (2, 1934)
    assert (rows["فحم"]["qty"], rows["فحم"]["amount"]) == (1, 500)
    assert [r["name"] for r in by_product["rows"]] == ["أرجيلة كبيرة", "فحم"]  # top first
    assert [r["detail"] for r in by_variant["rows"]][0] == "أسود"
    assert by_category["rows"][0]["name"] == "أراجيل"


def test_slow_sellers_lead_with_what_sold_nothing(api: TestClient) -> None:
    Shop(api)
    extra = helpers.product(api, "ملقط", category_id=helpers.category(api, "قطع")["id"])
    helpers.variant(api, extra["id"], price=900)
    slow = get(
        api,
        "/products",
        by="product",
        order="slow",
        limit=5,
        **{"from": "2026-10-29", "to": "2026-11-03"},
    )
    assert [r["name"] for r in slow["rows"]] == ["ملقط", "فحم", "أرجيلة كبيرة"]
    assert slow["rows"][0]["qty"] == 0


def test_collections_by_method_and_by_day(api: TestClient) -> None:
    Shop(api)
    body = get(api, "/collections", **{"from": "2026-10-30", "to": "2026-11-02"})
    methods = {r["key"]: r for r in body["by_method"]}
    assert (methods["cash"]["received"], methods["cash"]["refunded"]) == (1700, 200)  # 10.00 + 7.00
    assert (methods["transfer"]["received"], methods["transfer"]["net"]) == (1000, 1000)
    assert methods["cheque"]["received"] == 0
    days = {r["key"]: r for r in body["by_day"]}
    assert days["2026-10-30"]["received"] == 2000
    assert (days["2026-11-01"]["received"], days["2026-11-01"]["refunded"]) == (700, 200)
    assert (body["received"], body["refunded"], body["net"]) == (2700, 200, 2500)  # the void is out


def test_balances_sorted_with_days_since_the_last_payment(
    api: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    Shop(api)
    monkeypatch.setattr(reports, "today", lambda: date(2026, 11, 3))
    body = get(api, "/balances")
    by_name = {r["name"]: r for r in body["rows"]}
    # Ahmad: 2900 - 966 (return) - 1000 - 700 (paid) + 200 (refund) = 434
    assert by_name["أحمد"]["balance"] == 434
    # Bilal: 4000 opening + 1000 - 500 (damaged return) - 1000 (paid at the sale)
    assert by_name["بلال"]["balance"] == 3500
    assert [r["name"] for r in body["rows"]] == ["بلال", "أحمد"]
    assert by_name["أحمد"]["days_since_payment"] == 2  # paid on 01/11
    assert by_name["بلال"]["days_since_payment"] == 4  # the 30/10 payment; the 01/11 one was voided
    assert (body["total_owed"], body["total_credit"], body["owing"]) == (3934, 0, 2)


def test_a_customer_in_credit_is_listed_last_and_counted_apart(api: TestClient) -> None:
    cid = helpers.customer(api, name="دائن")
    assert helpers.push_one(api, helpers.payment_cmd(cid, 5000))["status"] == "applied"
    owing = helpers.customer(api, name="مدين", opening_balance=1200)
    assert owing
    body = get(api, "/balances")
    assert [r["name"] for r in body["rows"]] == ["مدين", "دائن"]
    assert (body["total_owed"], body["total_credit"]) == (1200, 5000)
    assert get(api, "/balances")["rows"][1]["balance"] == -5000


def test_stock_report_splits_low_out_and_negative(api: TestClient) -> None:
    cid = helpers.customer(api)
    p = helpers.product(api, "منتج")
    ok = helpers.variant(api, p["id"], price=100, color="a", min_stock=2)["id"]
    low = helpers.variant(api, p["id"], price=100, color="b", min_stock=5)["id"]
    out = helpers.variant(api, p["id"], price=100, color="c", min_stock=5)["id"]
    over = helpers.variant(api, p["id"], price=100, color="d", min_stock=1)["id"]
    stopped = helpers.variant(api, p["id"], price=100, color="e", min_stock=1)["id"]
    for v, qty in ((ok, 10), (low, 5), (over, 1)):
        helpers.stock_in(api, v, qty)
    # selling more than there is leaves a negative quantity (recorded with a warning)
    assert helpers.sell(api, cid, [(over, 3, 100)])["status"] == "applied"
    r = api.patch(f"/api/v1/variants/{stopped}", json={"is_active": False})
    assert r.status_code == 200
    body = get(api, "/stock")
    colors = {k: [x["color"] for x in v] for k, v in body.items()}
    assert colors == {"low": ["b"], "out": ["c"], "negative": ["d"]}
    assert body["negative"][0]["qty"] == -2 and out and low


def test_damaged_report_has_write_offs_and_damaged_returns(api: TestClient) -> None:
    Shop(api)
    body = get(api, "/damaged", **{"from": "2026-10-01", "to": "2026-11-03"})
    by_source = {r["source"]: r for r in body["rows"]}
    assert by_source["write_off"]["qty"] == 4 and by_source["write_off"]["note"] == "سقطت"
    assert by_source["return"]["qty"] == 1 and by_source["return"]["ref"].startswith("RET-")
    assert (body["write_off_qty"], body["return_qty"]) == (4, 1)
    # a restocked return is not damaged
    assert len(body["rows"]) == 2
    narrow = get(api, "/damaged", **{"from": "2026-10-01", "to": "2026-11-01"})
    assert [r["source"] for r in narrow["rows"]] == []


def test_the_period_is_checked(api: TestClient) -> None:
    for path, params in (
        ("/sales", {"from": "2026-11-05", "to": "2026-11-01"}),
        ("/sales", {"from": "1999-01-01", "to": "2026-11-01"}),
        ("/sales", {"from": "2026-01-01", "to": "2101-01-01"}),
        ("/sales", {"from": "2020-01-01", "to": "2026-11-01"}),  # more than two years of days
        ("/sales", {"group": "week"}),
        ("/products", {"by": "colour"}),
        ("/products", {"limit": 0}),
        ("/products", {"limit": 500}),
        ("/collections", {"from": "nope"}),
    ):
        r = api.get(V1 + path, params=params)
        assert r.status_code == 422, (path, params, r.status_code)
    # a long stretch is fine by month
    assert (
        api.get(
            V1 + "/sales", params={"group": "month", "from": "2020-01-01", "to": "2026-11-01"}
        ).status_code
        == 422
    )
    assert (
        api.get(
            V1 + "/sales", params={"group": "month", "from": "2025-01-01", "to": "2026-11-01"}
        ).status_code
        == 200
    )


def test_defaults_are_this_month_so_far(api: TestClient) -> None:
    body = get(api, "/sales")
    assert (body["rows"][0]["period"], body["rows"][-1]["period"]) == ("2026-11-01", "2026-11-03")


def test_reports_need_a_session(client: TestClient) -> None:
    for path in ("/sales", "/products", "/collections", "/balances", "/stock", "/damaged"):
        assert client.get(V1 + path).status_code == 401


# --- random histories against a reference written from the rows ------------------------------


def _local(moment: datetime) -> date:
    return moment.astimezone(HEBRON).date()


@pytest.mark.parametrize("seed", range(6))
def test_random_histories_match_a_reference(api: TestClient, db: Session, seed: int) -> None:
    rng = random.Random(seed)
    cats = helpers.category(api, "فئة")["id"]
    variants = []
    for i in range(4):
        product = helpers.product(api, f"منتج {i}", category_id=cats)
        variants.append(helpers.variant(api, product["id"], price=rng.randrange(100, 5000))["id"])
        helpers.stock_in(api, variants[-1], 200)
    customers_ = [helpers.customer(api, name=f"زبون {i}") for i in range(3)]
    sales: list[dict[str, Any]] = []
    first = date(2026, 9, 20)

    def stamp(hours: int = 0) -> str:
        day = first + timedelta(days=rng.randrange(0, 45))
        at = datetime(
            day.year, day.month, day.day, rng.randrange(0, 24), rng.randrange(60), tzinfo=UTC
        )
        return (at + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    for _ in range(80):
        kind = rng.choice(["sale"] * 4 + ["return", "payment", "refund", "cancel", "void"])
        if kind == "sale":
            lines = [
                (rng.choice(variants), rng.randrange(1, 5), rng.randrange(100, 5000))
                for _ in range(rng.randrange(1, 4))
            ]
            subtotal = sum(q * p for _, q, p in lines)
            cmd = helpers.invoice_cmd(
                rng.choice(customers_),
                lines,
                discount=rng.choice([0, 0, rng.randrange(0, subtotal)]),
                paid=rng.choice([0, rng.randrange(1, subtotal)]),
                method=rng.choice(["cash", "transfer", "cheque"]),
                pay_note="ش",
                issued_at=stamp(),
            )
            if helpers.push_one(api, cmd)["status"] == "applied":
                sales.append(cmd)
        elif kind == "return" and sales:
            sale = rng.choice(sales)
            n = len(sale["payload"]["lines"])
            picks = [(i, rng.randrange(1, 3), rng.choice(["restock", "damaged"])) for i in range(n)]
            helpers.push_one(api, helpers.return_cmd(sale, picks, issued_at=stamp()))
        elif kind == "payment":
            helpers.push_one(
                api,
                helpers.payment_cmd(
                    rng.choice(customers_),
                    rng.randrange(1, 9000),
                    method=rng.choice(["cash", "transfer"]),
                    paid_at=stamp(),
                ),
            )
        elif kind == "refund":
            helpers.push_one(
                api,
                helpers.refund_cmd(
                    rng.choice(customers_), rng.randrange(1, 3000), refunded_at=stamp()
                ),
            )
        elif kind == "cancel" and sales:
            sale = rng.choice(sales)
            helpers.push_one(
                api,
                helpers.command(
                    "invoice.cancel",
                    {
                        "invoice_id": sale["payload"]["invoice_id"],
                        "cancelled_at": stamp(),
                        "reason": "x",
                        "void_payment": rng.random() < 0.5,
                        "lines": [],
                    },
                ),
            )
        elif kind == "void":
            pays = db.scalars(select(Payment).where(Payment.kind == "payment")).all()
            if pays:
                helpers.push_one(api, helpers.void_cmd(str(rng.choice(pays).id), voided_at=stamp()))

    db.rollback()
    # the window holds every date the history can produce (the last ones run past midnight)
    start, end = date(2026, 9, 15), date(2026, 11, 10)
    window = {"from": start.isoformat(), "to": end.isoformat()}

    # reference: straight from the rows
    gross: dict[date, int] = defaultdict(int)
    count: dict[date, int] = defaultdict(int)
    back: dict[date, int] = defaultdict(int)
    for inv in db.scalars(select(Invoice).where(Invoice.status == "confirmed")):
        gross[_local(inv.issued_at)] += inv.total
        count[_local(inv.issued_at)] += 1
    for ret in db.scalars(select(Return)):
        back[_local(ret.issued_at)] += ret.total

    day = get(api, "/sales", group="day", **window)
    assert len(day["rows"]) == (end - start).days + 1
    for row in day["rows"]:
        d = date.fromisoformat(row["period"])
        assert (row["gross"], row["invoices"], row["returns"]) == (gross[d], count[d], back[d]), d
        assert row["net"] == row["gross"] - row["returns"]
    month = get(api, "/sales", group="month", **window)
    assert month["net"] == day["net"] and month["gross"] == day["gross"]
    assert day["net"] == sum(gross.values()) - sum(back.values())

    # products add up to the same net, however they are grouped
    for by in ("product", "variant", "category"):
        body = get(api, "/products", by=by, limit=200, **window)
        assert body["amount"] == day["net"], by
    all_lines = list(db.scalars(select(InvoiceLine)))
    live = {i.id for i in db.scalars(select(Invoice).where(Invoice.status == "confirmed"))}
    variant_of = {ln.id: ln.variant_id for ln in all_lines}
    per_variant: dict[uuid.UUID, list[int]] = defaultdict(lambda: [0, 0])
    for ln in all_lines:
        if ln.invoice_id in live:
            per_variant[ln.variant_id][0] += ln.qty
            per_variant[ln.variant_id][1] += ln.line_total - ln.discount_share
    for rl in db.scalars(select(ReturnLine)):
        per_variant[variant_of[rl.invoice_line_id]][0] -= rl.qty
        per_variant[variant_of[rl.invoice_line_id]][1] -= rl.amount
    got = {
        r["id"]: (r["qty"], r["amount"])
        for r in get(api, "/products", by="variant", limit=200, **window)["rows"]
    }
    for var, (qty, amount) in per_variant.items():
        if qty > 0 or amount > 0:
            assert got[str(var)] == (qty, amount), var

    # collections
    pays = db.scalars(select(Payment).where(Payment.status == "active")).all()
    body = get(api, "/collections", **window)
    assert body["received"] == sum(p.amount for p in pays if p.kind == "payment")
    assert body["refunded"] == sum(p.amount for p in pays if p.kind == "refund")
    for row in body["by_day"]:
        d = date.fromisoformat(row["key"])
        assert row["received"] == sum(
            p.amount for p in pays if p.kind == "payment" and _local(p.paid_at) == d
        )

    # balances: the report and the pull agree on every customer
    pulled = {
        c["id"]: c["balance"]
        for c in api.get("/api/v1/sync/pull", params={"cursor": 0}).json()["changes"]["customers"]
    }
    listed = get(api, "/balances")
    assert {r["id"]: r["balance"] for r in listed["rows"]} == {
        k: v for k, v in pulled.items() if v != 0
    }
    assert listed["total_owed"] - listed["total_credit"] == sum(pulled.values())

    # stock lists cover exactly the variants whose quantity says so
    stock = get(api, "/stock")
    active = [v for v in db.scalars(select(ProductVariant)) if v.is_active]
    assert {r["variant_id"] for r in stock["negative"]} == {
        str(v.id) for v in active if v.stock_qty < 0
    }
    assert {r["variant_id"] for r in stock["out"]} == {
        str(v.id) for v in active if v.stock_qty == 0
    }

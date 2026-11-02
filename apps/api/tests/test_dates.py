"""The dates a command carries come from the iPad's clock. A clock that is a little off passes; one
that is plainly wrong is refused, so a document never lands in the wrong month of a statement."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import clock
from app.services import sync as sync_service
from tests import helpers

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def the_real_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "utcnow", lambda: NOW)
    monkeypatch.setattr(sync_service, "FUTURE_TOLERANCE", sync_service.DEFAULT_FUTURE_TOLERANCE)


def stamp(delta: timedelta) -> str:
    return (NOW + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def sale_at(api: TestClient, moment: str) -> dict[str, Any]:
    cid = helpers.customer(api)
    product = helpers.product(api)
    variant = helpers.variant(api, product["id"], price=100)["id"]
    helpers.stock_in(api, variant, 10)
    return helpers.sell(api, cid, [(variant, 1, 100)], issued_at=moment)


def test_a_little_clock_error_passes(api: TestClient) -> None:
    for delta in (timedelta(minutes=-5), timedelta(minutes=5), timedelta(hours=20)):
        assert sale_at(api, stamp(delta))["status"] == "applied", delta


def test_a_date_more_than_a_day_ahead_is_refused_and_nothing_is_saved(api: TestClient) -> None:
    result = sale_at(api, stamp(timedelta(days=2)))
    assert result["status"] == "rejected"
    assert result["error"]["code"] == "DATE_IN_FUTURE"
    assert result["error"]["details"]["field"] == "issued_at"
    pulled = api.get("/api/v1/sync/pull", params={"cursor": 0}).json()["changes"]
    assert pulled["invoices"] == []


def test_a_date_before_2020_is_refused(api: TestClient) -> None:
    result = sale_at(api, "2019-12-31T23:59:59Z")
    assert result["error"]["code"] == "DATE_TOO_OLD"
    assert sale_at(api, "2020-01-01T00:00:00Z")["status"] == "applied"


@pytest.mark.parametrize(
    "build",
    [
        lambda cid, when: helpers.payment_cmd(cid, 100, paid_at=when),
        lambda cid, when: helpers.refund_cmd(cid, 100, refunded_at=when),
    ],
)
def test_payments_and_refunds_follow_the_same_rule(api: TestClient, build: Any) -> None:
    cid = helpers.customer(api)
    assert helpers.push_one(api, build(cid, stamp(timedelta(hours=1))))["status"] == "applied"
    late = helpers.push_one(api, build(cid, stamp(timedelta(days=3))))
    assert late["error"]["code"] == "DATE_IN_FUTURE"


def test_the_other_dates_are_checked_too(api: TestClient) -> None:
    cid = helpers.customer(api)
    pay = helpers.payment_cmd(cid, 100, paid_at=stamp(timedelta(hours=-2)))
    assert helpers.push_one(api, pay)["status"] == "applied"
    void = helpers.void_cmd(pay["payload"]["payment_id"], voided_at=stamp(timedelta(days=9)))
    assert helpers.push_one(api, void)["error"]["code"] == "DATE_IN_FUTURE"
    deliver = helpers.command(
        "invoice.mark_delivered",
        {
            "invoice_id": "00000000-0000-0000-0000-000000000001",
            "delivered_at": stamp(timedelta(days=9)),
        },
    )
    assert helpers.push_one(api, deliver)["error"]["code"] == "DATE_IN_FUTURE"


def test_a_refused_date_is_remembered_so_a_resend_gets_the_same_answer(api: TestClient) -> None:
    cid = helpers.customer(api)
    cmd = helpers.payment_cmd(cid, 100, paid_at=stamp(timedelta(days=5)))
    first = helpers.push_one(api, cmd)
    assert helpers.push_one(api, cmd) == first

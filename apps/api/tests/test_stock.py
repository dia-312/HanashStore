import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.cli import main as cli_main
from app.db import get_engine
from app.models import ProductVariant, StockMovement
from app.services.stock import stock_mismatches
from tests import helpers

V1 = "/api/v1"


def _variant(api: TestClient, **extra: Any) -> str:
    p = helpers.product(api)
    return str(helpers.variant(api, p["id"], **extra)["id"])


def _qty(api: TestClient, variant_id: str) -> int:
    detail = api.get(V1 + "/variants", params={"limit": 200}).json()["items"]
    return int(next(i["stock_qty"] for i in detail if i["id"] == variant_id))


def _adjust(api: TestClient, variant_id: str, counted: int, note: str = "count") -> Any:
    return api.post(
        V1 + "/stock/adjust",
        json={
            "id": str(uuid.uuid4()),
            "variant_id": variant_id,
            "counted_qty": counted,
            "note": note,
        },
    )


def _damage(api: TestClient, variant_id: str, qty: int, note: str = "dropped") -> Any:
    return api.post(
        V1 + "/stock/damage",
        json={"id": str(uuid.uuid4()), "variant_id": variant_id, "qty": qty, "note": note},
    )


def test_opening_quantity_creates_an_opening_movement(api: TestClient) -> None:
    v = _variant(api, opening_qty=30)
    items = api.get(f"{V1}/variants/{v}/movements").json()["items"]
    assert [(m["type"], m["qty"], m["running_total"]) for m in items] == [("opening", 30, 30)]


def test_stock_in_adds_and_reports_the_new_quantities(api: TestClient) -> None:
    a, b = _variant(api, opening_qty=5), _variant(api, opening_qty=0)
    r = api.post(
        V1 + "/stock/in",
        json={
            "note": "مورد 1",
            "items": [
                {"id": str(uuid.uuid4()), "variant_id": a, "qty": 10},
                {"id": str(uuid.uuid4()), "variant_id": b, "qty": 3},
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["applied"] == 2
    assert {v["id"]: v["stock_qty"] for v in r.json()["variants"]} == {a: 15, b: 3}


def test_sending_the_same_movement_id_twice_applies_it_once(api: TestClient) -> None:
    v = _variant(api)
    body = {"items": [{"id": str(uuid.uuid4()), "variant_id": v, "qty": 4}]}
    first, second = api.post(V1 + "/stock/in", json=body), api.post(V1 + "/stock/in", json=body)
    assert (first.json()["applied"], second.json()["applied"]) == (1, 0)
    assert _qty(api, v) == 4
    # Reusing the id for something different is an error, not a silent overwrite.
    clash = {"items": [{**body["items"][0], "qty": 9}]}
    assert api.post(V1 + "/stock/in", json=clash).json()["code"] == "MOVEMENT_ID_CONFLICT"


def test_adjustment_records_the_difference_and_needs_a_reason(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    assert _adjust(api, v, 7).status_code == 200
    assert _qty(api, v) == 7
    movements = api.get(f"{V1}/variants/{v}/movements").json()["items"]
    assert (movements[0]["type"], movements[0]["qty"], movements[0]["running_total"]) == (
        "adjustment",
        -3,
        7,
    )
    assert _adjust(api, v, 12).status_code == 200  # a count above the system is positive
    assert _qty(api, v) == 12
    no_note = api.post(
        V1 + "/stock/adjust",
        json={"id": str(uuid.uuid4()), "variant_id": v, "counted_qty": 1, "note": "  "},
    )
    assert no_note.status_code == 422
    same = _adjust(api, v, 12)
    assert same.status_code == 409 and same.json()["code"] == "NO_DIFFERENCE"


def test_repeating_an_adjustment_does_not_apply_it_twice(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    body = {"id": str(uuid.uuid4()), "variant_id": v, "counted_qty": 4, "note": "جرد"}
    assert api.post(V1 + "/stock/adjust", json=body).json()["applied"] == 1
    assert api.post(V1 + "/stock/adjust", json=body).json()["applied"] == 0
    assert _qty(api, v) == 4


def test_damage_removes_stock_and_cannot_go_below_zero(api: TestClient) -> None:
    v = _variant(api, opening_qty=5)
    assert _damage(api, v, 2).status_code == 200
    assert _qty(api, v) == 3
    r = _damage(api, v, 4)
    assert r.status_code == 409
    assert r.json()["code"] == "INSUFFICIENT_STOCK"
    assert r.json()["details"]["available"] == 3
    assert _qty(api, v) == 3
    assert _adjust(api, v, 0).status_code == 200  # counting zero is fine
    assert _damage(api, v, 1).status_code == 409


def test_a_failed_batch_changes_nothing(api: TestClient, db: Session) -> None:
    good = _variant(api, opening_qty=1)
    bad = str(uuid.uuid4())  # no such variant
    r = api.post(
        V1 + "/stock/in",
        json={
            "items": [
                {"id": str(uuid.uuid4()), "variant_id": good, "qty": 5},
                {"id": str(uuid.uuid4()), "variant_id": bad, "qty": 5},
            ]
        },
    )
    assert r.status_code == 404
    assert _qty(api, good) == 1
    assert db.scalar(select(func.count()).select_from(StockMovement)) == 1


@pytest.mark.parametrize("qty", [0, -1, 100_001])
def test_quantities_are_bounded(api: TestClient, qty: int) -> None:
    v = _variant(api)
    r = api.post(
        V1 + "/stock/in", json={"items": [{"id": str(uuid.uuid4()), "variant_id": v, "qty": qty}]}
    )
    assert r.status_code == 422


def test_purchase_into_a_deactivated_variant_is_refused(api: TestClient) -> None:
    v = _variant(api)
    api.patch(f"{V1}/variants/{v}", json={"is_active": False})
    r = helpers.stock_in(api, v, 1)
    assert r.status_code == 409 and r.json()["code"] == "VARIANT_INACTIVE"


def test_history_has_a_running_total_and_pages_newest_first(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    helpers.stock_in(api, v, 5)
    _damage(api, v, 3)
    _adjust(api, v, 20)  # +8
    page1 = api.get(f"{V1}/variants/{v}/movements", params={"limit": 2}).json()
    assert [(m["type"], m["qty"], m["running_total"]) for m in page1["items"]] == [
        ("adjustment", 8, 20),
        ("damage", -3, 12),
    ]
    page2 = api.get(
        f"{V1}/variants/{v}/movements", params={"limit": 2, "cursor": page1["next_cursor"]}
    ).json()
    assert [(m["type"], m["running_total"]) for m in page2["items"]] == [
        ("purchase", 15),
        ("opening", 10),
    ]
    assert page2["next_cursor"] is None


def test_stock_cache_always_equals_the_sum_of_movements(api: TestClient, db: Session) -> None:
    variants = [_variant(api, opening_qty=n) for n in (0, 3, 50)]
    for v in variants:
        helpers.stock_in(api, v, 7)
        _damage(api, v, 2)
        _adjust(api, v, 11)
    assert stock_mismatches(db) == []
    total = db.scalar(select(func.sum(StockMovement.qty)))
    assert total == db.scalar(select(func.sum(ProductVariant.stock_qty)))


def test_recompute_stock_reports_and_fixes_a_broken_cache(
    api: TestClient, db: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    v = _variant(api, opening_qty=9)
    with get_engine().begin() as conn:  # simulate a bug or a hand edit
        conn.execute(text("UPDATE product_variants SET stock_qty = 100"))
    db.expire_all()
    assert len(stock_mismatches(db)) == 1
    assert cli_main(["recompute-stock"]) == 1  # report only: non-zero exit, nothing fixed
    assert "100" in capsys.readouterr().out
    assert cli_main(["recompute-stock", "--fix"]) == 0
    db.expire_all()
    assert stock_mismatches(db) == []
    assert db.get(ProductVariant, uuid.UUID(v)).stock_qty == 9  # type: ignore[union-attr]


def test_concurrent_looking_requests_cannot_oversell(api: TestClient) -> None:
    # Two damage requests that together exceed stock: the second must be refused.
    v = _variant(api, opening_qty=5)
    assert _damage(api, v, 3).status_code == 200
    assert _damage(api, v, 3).status_code == 409
    assert _qty(api, v) == 2

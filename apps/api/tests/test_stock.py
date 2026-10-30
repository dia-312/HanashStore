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


def _code(result: dict[str, Any]) -> str:
    assert result["status"] == "rejected", result
    return str(result["error"]["code"])


def test_opening_quantity_creates_an_opening_movement(api: TestClient) -> None:
    v = _variant(api, opening_qty=30)
    items = api.get(f"{V1}/variants/{v}/movements").json()["items"]
    assert [(m["type"], m["qty"], m["running_total"]) for m in items] == [("opening", 30, 30)]


def test_stock_in_adds_and_reports_the_new_quantities(api: TestClient) -> None:
    a, b = _variant(api, opening_qty=5), _variant(api, opening_qty=0)
    result = helpers.push_one(api, helpers.purchase_cmd([(a, 10), (b, 3)], "مورد 1"))
    assert result["status"] == "applied"
    assert result["data"]["applied"] == 2
    assert {v["id"]: v["stock_qty"] for v in result["data"]["variants"]} == {a: 15, b: 3}
    assert _qty(api, a) == 15


def test_sending_the_same_command_twice_applies_it_once(api: TestClient) -> None:
    v = _variant(api)
    cmd = helpers.purchase_cmd([(v, 4)])
    first, second = helpers.push_one(api, cmd), helpers.push_one(api, cmd)
    assert first["status"] == second["status"] == "applied"
    assert first == second  # the stored result comes back unchanged
    assert _qty(api, v) == 4


def test_reusing_a_movement_id_for_something_different_is_refused(api: TestClient) -> None:
    v = _variant(api)
    movement_id = str(uuid.uuid4())
    one = {"movement_id": movement_id, "variant_id": v, "qty": 4}
    assert (
        helpers.push_one(api, helpers.command("stock.purchase", {"items": [one]}))["status"]
        == "applied"
    )
    clash = {**one, "qty": 9}
    result = helpers.push_one(api, helpers.command("stock.purchase", {"items": [clash]}))
    assert _code(result) == "MOVEMENT_ID_CONFLICT"
    assert _qty(api, v) == 4


def test_adjustment_records_the_difference_and_needs_a_reason(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    assert helpers.adjust(api, v, 7)["status"] == "applied"
    assert _qty(api, v) == 7
    movements = api.get(f"{V1}/variants/{v}/movements").json()["items"]
    assert (movements[0]["type"], movements[0]["qty"], movements[0]["running_total"]) == (
        "adjustment",
        -3,
        7,
    )
    assert helpers.adjust(api, v, 12)["status"] == "applied"  # above the system: positive
    assert _qty(api, v) == 12
    assert _code(helpers.adjust(api, v, 1, note="  ")) == "VALIDATION_ERROR"


def test_a_count_equal_to_the_system_is_a_harmless_no_op(api: TestClient) -> None:
    v = _variant(api, opening_qty=12)
    result = helpers.adjust(api, v, 12)
    assert result["status"] == "applied" and result["data"]["applied"] == 0
    assert [w["code"] for w in result["warnings"]] == ["NO_DIFFERENCE"]


def test_adjustment_warns_when_the_device_saw_another_quantity(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    result = helpers.adjust(api, v, 4, expected=8)
    assert result["status"] == "applied"
    assert result["warnings"] == [{"code": "STOCK_DIFFERS", "expected": 8, "actual": 10}]
    assert _qty(api, v) == 4  # the counted quantity wins


def test_repeating_an_adjustment_does_not_apply_it_twice(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    payload = {"movement_id": str(uuid.uuid4()), "variant_id": v, "counted_qty": 4, "note": "جرد"}
    cmd = helpers.command("stock.adjust", payload)
    helpers.push_one(api, cmd)
    helpers.push_one(api, cmd)
    # Even with a fresh command id the same movement id is not applied again.
    again = helpers.push_one(api, helpers.command("stock.adjust", payload))
    assert again["status"] == "applied" and again["data"]["applied"] == 0
    assert _qty(api, v) == 4


def test_damage_removes_stock_and_cannot_go_below_zero(api: TestClient) -> None:
    v = _variant(api, opening_qty=5)
    assert helpers.damage(api, v, 2)["status"] == "applied"
    assert _qty(api, v) == 3
    rejected = helpers.damage(api, v, 4)
    assert _code(rejected) == "INSUFFICIENT_STOCK"
    assert rejected["error"]["details"]["available"] == 3
    assert _qty(api, v) == 3
    assert helpers.adjust(api, v, 0)["status"] == "applied"  # counting zero is fine
    assert _code(helpers.damage(api, v, 1)) == "INSUFFICIENT_STOCK"


def test_a_failed_command_changes_nothing(api: TestClient, db: Session) -> None:
    good = _variant(api, opening_qty=1)
    missing = str(uuid.uuid4())  # no such variant
    result = helpers.push_one(api, helpers.purchase_cmd([(good, 5), (missing, 5)]))
    assert _code(result) == "VARIANT_NOT_FOUND"
    assert _qty(api, good) == 1
    assert db.scalar(select(func.count()).select_from(StockMovement)) == 1


@pytest.mark.parametrize("qty", [0, -1, 100_001])
def test_quantities_are_bounded(api: TestClient, qty: int) -> None:
    v = _variant(api)
    result = helpers.push_one(api, helpers.purchase_cmd([(v, qty)]))
    assert _code(result) == "VALIDATION_ERROR"


def test_purchase_into_a_deactivated_variant_is_refused(api: TestClient) -> None:
    v = _variant(api)
    api.patch(f"{V1}/variants/{v}", json={"is_active": False})
    assert _code(helpers.stock_in(api, v, 1)) == "VARIANT_INACTIVE"


def test_history_has_a_running_total_and_pages_newest_first(api: TestClient) -> None:
    v = _variant(api, opening_qty=10)
    helpers.stock_in(api, v, 5)
    helpers.damage(api, v, 3)
    helpers.adjust(api, v, 20)  # +8
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
        helpers.damage(api, v, 2)
        helpers.adjust(api, v, 11)
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


def test_two_damage_commands_that_together_exceed_stock_cannot_oversell(api: TestClient) -> None:
    v = _variant(api, opening_qty=5)
    assert helpers.damage(api, v, 3)["status"] == "applied"
    assert _code(helpers.damage(api, v, 3)) == "INSUFFICIENT_STOCK"
    assert _qty(api, v) == 2

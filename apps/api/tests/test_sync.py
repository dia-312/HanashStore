import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog, ProcessedCommand, StockMovement
from app.services import settings
from app.services import sync as sync_service
from tests import helpers
from tests.conftest import new_client

V1 = "/api/v1"


def _pull(api: TestClient, cursor: int = 0) -> dict[str, Any]:
    r = api.get(V1 + "/sync/pull", params={"cursor": cursor})
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def _variant(api: TestClient, **extra: Any) -> str:
    p = helpers.product(api)
    return str(helpers.variant(api, p["id"], **extra)["id"])


def _ids(page: dict[str, Any]) -> set[str]:
    return {r["id"] for group in page["changes"].values() for r in group}


# --- pull -------------------------------------------------------------------------------------


def test_pull_on_an_empty_server(api: TestClient) -> None:
    page = _pull(api)
    assert page == {
        "changes": {
            "categories": [],
            "products": [],
            "variants": [],
            "images": [],
            "customers": [],
            "invoices": [],
            "invoice_lines": [],
            "payments": [],
            "returns": [],
            "return_lines": [],
        },
        "cursor": 0,
        "has_more": False,
        "settings": settings.DEFAULTS,
    }


def test_pull_returns_everything_then_nothing_new(api: TestClient) -> None:
    p = helpers.product(api)
    v = helpers.variant(api, p["id"], 4500, color="أسود", opening_qty=7)
    page = _pull(api)
    assert [c["id"] for c in page["changes"]["categories"]] == [p["category_id"]]
    assert [x["id"] for x in page["changes"]["products"]] == [p["id"]]
    variant = page["changes"]["variants"][0]
    assert (variant["id"], variant["stock_qty"], variant["price"], variant["color"]) == (
        v["id"],
        7,
        4500,
        "أسود",
    )
    assert page["cursor"] == max(
        r["change_seq"] for group in page["changes"].values() for r in group
    )
    assert page["has_more"] is False
    again = _pull(api, page["cursor"])
    assert _ids(again) == set() and again["cursor"] == page["cursor"]


def test_a_changed_row_comes_again_with_a_higher_change_seq(api: TestClient) -> None:
    v = _variant(api, opening_qty=3)
    first = _pull(api)
    before = first["changes"]["variants"][0]["change_seq"]
    helpers.stock_in(api, v, 2)
    second = _pull(api, first["cursor"])
    changed = second["changes"]["variants"]
    assert [(c["id"], c["stock_qty"]) for c in changed] == [(v, 5)]
    assert changed[0]["change_seq"] > before
    assert second["changes"]["products"] == []  # untouched rows are not sent again


def test_deactivated_rows_are_still_sent_so_the_device_learns_about_them(api: TestClient) -> None:
    v = _variant(api)
    cursor = _pull(api)["cursor"]
    api.patch(f"{V1}/variants/{v}", json={"is_active": False})
    changed = _pull(api, cursor)["changes"]["variants"]
    assert [(c["id"], c["is_active"]) for c in changed] == [(v, False)]


def test_pages_cover_every_row_once_in_change_seq_order(api: TestClient, db: Session) -> None:
    for i in range(6):
        p = helpers.product(api, f"منتج {i}")
        helpers.variant(api, p["id"], 100 + i, opening_qty=i)
    everything = _ids(_pull(api))
    seen: list[str] = []
    seqs: list[int] = []
    cursor = 0
    for _ in range(50):
        page = sync_service.pull(db, cursor, limit=4).model_dump(mode="json")
        seen += [r["id"] for group in page["changes"].values() for r in group]
        seqs += [r["change_seq"] for group in page["changes"].values() for r in group]
        assert page["cursor"] >= cursor
        cursor = page["cursor"]
        if not page["has_more"]:
            break
    else:
        raise AssertionError("pull never finished")
    assert sorted(seen) == sorted(everything)  # nothing missing, nothing twice
    assert len(seen) == len(set(seen))
    assert max(seqs) == cursor


def test_one_transaction_is_never_split_across_pages(api: TestClient, db: Session) -> None:
    csv = "المنتج,الفئة,اللون,المقاس,السعر,الكمية\n" + "\n".join(
        f"صنف {i},فئة,,{i},10,{i}" for i in range(1, 9)
    )
    r = api.post(
        V1 + "/import/products",
        params={"dry_run": "false"},
        files={"file": ("p.csv", io.BytesIO(csv.encode("utf-8")), "text/csv")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["committed"] is True
    # The import wrote 1 category + 8 products + 8 variants under one change_seq.
    page = sync_service.pull(db, 0, limit=3).model_dump(mode="json")
    total = sum(len(group) for group in page["changes"].values())
    assert total == 17 and page["has_more"] is False
    assert len({r["change_seq"] for group in page["changes"].values() for r in group}) == 1


def test_cursor_must_not_be_negative(api: TestClient) -> None:
    assert api.get(V1 + "/sync/pull", params={"cursor": -1}).status_code == 422


# --- push -------------------------------------------------------------------------------------


def test_push_answers_with_a_result_per_command_and_a_cursor(api: TestClient) -> None:
    v = _variant(api, opening_qty=5)
    body = helpers.push(api, helpers.purchase_cmd([(v, 3)]), helpers.command("stock.nope", {}))
    assert [r["status"] for r in body["results"]] == ["applied", "rejected"]
    assert body["results"][1]["error"]["code"] == "UNKNOWN_COMMAND"
    assert body["cursor"] == _pull(api)["cursor"]


def test_applied_data_carries_the_new_stock_and_change_seq(api: TestClient) -> None:
    v = _variant(api, opening_qty=5)
    result = helpers.stock_in(api, v, 3)
    state = result["data"]["variants"][0]
    assert (state["id"], state["stock_qty"]) == (v, 8)
    pulled = next(x for x in _pull(api)["changes"]["variants"] if x["id"] == v)
    assert pulled["change_seq"] == state["change_seq"]


def test_commands_in_one_request_apply_in_the_order_sent(api: TestClient) -> None:
    v = _variant(api, opening_qty=0)
    ok = helpers.push(
        api,
        helpers.purchase_cmd([(v, 5)]),
        helpers.command(
            "stock.damage",
            {"movement_id": str(uuid.uuid4()), "variant_id": v, "qty": 5, "note": "x"},
        ),
    )
    assert [r["status"] for r in ok["results"]] == ["applied", "applied"]
    w = _variant(api, opening_qty=0)
    wrong_order = helpers.push(
        api,
        helpers.command(
            "stock.damage",
            {"movement_id": str(uuid.uuid4()), "variant_id": w, "qty": 5, "note": "x"},
        ),
        helpers.purchase_cmd([(w, 5)]),
    )
    assert [r["status"] for r in wrong_order["results"]] == ["rejected", "applied"]


def test_a_rejected_command_is_stored_and_answered_the_same_when_resent(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, opening_qty=1)
    cmd = helpers.command(
        "stock.damage", {"movement_id": str(uuid.uuid4()), "variant_id": v, "qty": 5, "note": "x"}
    )
    first = helpers.push_one(api, cmd)
    # Meanwhile stock grows: a resend must still return the stored rejection, not re-decide.
    helpers.stock_in(api, v, 100)
    second = helpers.push_one(api, cmd)
    assert first == second and first["status"] == "rejected"
    assert first["error"]["code"] == "INSUFFICIENT_STOCK"
    stored = db.get(ProcessedCommand, uuid.UUID(cmd["id"]))
    assert stored is not None and stored.status == "rejected"
    assert db.scalar(select(func.count()).select_from(StockMovement)) == 2  # opening + purchase


def test_unsupported_schema_version_is_rejected(api: TestClient) -> None:
    v = _variant(api)
    cmd = helpers.purchase_cmd([(v, 1)])
    cmd["schema_version"] = 99
    assert helpers.push_one(api, cmd)["error"]["code"] == "UNSUPPORTED_SCHEMA"


def test_a_bad_payload_is_a_rejection_with_the_fields_named(api: TestClient) -> None:
    result = helpers.push_one(api, helpers.command("stock.purchase", {"items": []}))
    assert result["status"] == "rejected"
    assert result["error"]["code"] == "VALIDATION_ERROR"
    assert result["error"]["details"]["errors"][0]["field"] == "items"


def test_commands_for_another_device_are_refused(api: TestClient) -> None:
    v = _variant(api)
    r = api.post(
        V1 + "/sync/push",
        json={"device_id": str(uuid.uuid4()), "commands": [helpers.purchase_cmd([(v, 1)])]},
    )
    assert r.status_code == 403 and r.json()["code"] == "DEVICE_MISMATCH"


def test_more_than_fifty_commands_in_one_request_is_a_validation_error(api: TestClient) -> None:
    v = _variant(api)
    commands = [helpers.purchase_cmd([(v, 1)]) for _ in range(51)]
    r = api.post(
        V1 + "/sync/push", json={"device_id": helpers.device_id(api), "commands": commands}
    )
    assert r.status_code == 422


def test_fifty_commands_are_accepted(api: TestClient) -> None:
    v = _variant(api)
    body = helpers.push(api, *[helpers.purchase_cmd([(v, 1)]) for _ in range(50)])
    assert [r["status"] for r in body["results"]] == ["applied"] * 50


def test_every_applied_command_leaves_an_audit_row(api: TestClient, db: Session) -> None:
    v = _variant(api)
    cmd = helpers.purchase_cmd([(v, 2)])
    helpers.push_one(api, cmd)
    helpers.push_one(api, cmd)  # a resend adds nothing
    rows = db.scalars(select(AuditLog).where(AuditLog.entity == "command")).all()
    assert [(r.entity_id, r.action) for r in rows] == [(uuid.UUID(cmd["id"]), "stock.purchase")]


def test_the_same_command_sent_at_the_same_moment_applies_once(
    api: TestClient, db: Session
) -> None:
    v = _variant(api, opening_qty=0)
    cmd = helpers.purchase_cmd([(v, 6)])
    device = helpers.device_id(api)
    other = new_client()
    other.cookies.update(api.cookies)

    def send(client: TestClient) -> dict[str, Any]:
        r = client.post(V1 + "/sync/push", json={"device_id": device, "commands": [cmd]})
        assert r.status_code == 200, r.text
        result: dict[str, Any] = r.json()["results"][0]
        return result

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = pool.map(send, [api, other])
    other.close()
    assert a["status"] == b["status"] == "applied"
    assert (
        db.scalar(
            select(func.sum(StockMovement.qty)).where(StockMovement.variant_id == uuid.UUID(v))
        )
        == 6
    )
    assert db.scalar(select(func.count()).select_from(ProcessedCommand)) == 1

"""Small builders that go through the real API, so tests exercise the same paths as the app."""

import uuid
from typing import Any

from fastapi.testclient import TestClient


def category(api: TestClient, name: str = "أراجيل") -> dict[str, Any]:
    r = api.post("/api/v1/categories", json={"name": name})
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def product(
    api: TestClient, name: str = "أرجيلة كبيرة", category_id: str | None = None, **extra: Any
) -> dict[str, Any]:
    cid = category_id or category(api, f"فئة {uuid.uuid4().hex[:6]}")["id"]
    r = api.post("/api/v1/products", json={"name": name, "category_id": cid, **extra})
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def variant(api: TestClient, product_id: str, price: int = 4500, **extra: Any) -> dict[str, Any]:
    r = api.post(f"/api/v1/products/{product_id}/variants", json={"price": price, **extra})
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def command(type_: str, payload: dict[str, Any], command_id: str | None = None) -> dict[str, Any]:
    return {
        "id": command_id or str(uuid.uuid4()),
        "type": type_,
        "schema_version": 1,
        "created_at": "2026-11-02T09:14:22Z",
        "payload": payload,
    }


def device_id(api: TestClient) -> str:
    return str(api.get("/api/v1/auth/me").json()["device"]["id"])


def push(api: TestClient, *commands: dict[str, Any]) -> dict[str, Any]:
    r = api.post(
        "/api/v1/sync/push", json={"device_id": device_id(api), "commands": list(commands)}
    )
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


def push_one(api: TestClient, cmd: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = push(api, cmd)["results"][0]
    return result


def purchase_cmd(items: list[tuple[str, int]], note: str | None = None) -> dict[str, Any]:
    return command(
        "stock.purchase",
        {
            "note": note,
            "items": [
                {"movement_id": str(uuid.uuid4()), "variant_id": v, "qty": q} for v, q in items
            ],
        },
    )


def stock_in(api: TestClient, variant_id: str, qty: int, note: str | None = None) -> dict[str, Any]:
    return push_one(api, purchase_cmd([(variant_id, qty)], note))


def damage(api: TestClient, variant_id: str, qty: int, note: str = "dropped") -> dict[str, Any]:
    payload = {"movement_id": str(uuid.uuid4()), "variant_id": variant_id, "qty": qty, "note": note}
    return push_one(api, command("stock.damage", payload))


def adjust(
    api: TestClient,
    variant_id: str,
    counted: int,
    note: str = "count",
    expected: int | None = None,
) -> dict[str, Any]:
    payload = {
        "movement_id": str(uuid.uuid4()),
        "variant_id": variant_id,
        "counted_qty": counted,
        "expected_qty": expected,
        "note": note,
    }
    return push_one(api, command("stock.adjust", payload))


def customer_cmd(
    customer_id: str | None = None, name: str = "محل النور", **extra: Any
) -> dict[str, Any]:
    payload = {"customer_id": customer_id or str(uuid.uuid4()), "name": name, **extra}
    return command("customer.upsert", payload)


def customer(api: TestClient, name: str = "محل النور", **extra: Any) -> str:
    """Adds a customer through the push path and returns his id."""
    cmd = customer_cmd(name=name, **extra)
    result = push_one(api, cmd)
    assert result["status"] == "applied", result
    return str(cmd["payload"]["customer_id"])


_NUMBERS = {"INV": 0, "REC": 0}


def next_number(kind: str) -> str:
    _NUMBERS[kind] += 1
    return f"{kind}-{_NUMBERS[kind]:06d}"


def invoice_cmd(
    customer_id: str,
    lines: list[tuple[str, int, int]],
    *,
    discount: int = 0,
    paid: int = 0,
    method: str = "cash",
    pay_note: str | None = None,
    number: str | None = None,
    issued_at: str = "2026-11-02T09:14:20Z",
    invoice_id: str | None = None,
) -> dict[str, Any]:
    """lines are (variant_id, qty, unit_price)."""
    payload: dict[str, Any] = {
        "invoice_id": invoice_id or str(uuid.uuid4()),
        "number": number or next_number("INV"),
        "customer_id": customer_id,
        "issued_at": issued_at,
        "discount": discount,
        "note": None,
        "lines": [
            {"line_id": str(uuid.uuid4()), "variant_id": v, "qty": q, "unit_price": p}
            for v, q, p in lines
        ],
    }
    if paid:
        payload["payment"] = {
            "payment_id": str(uuid.uuid4()),
            "number": next_number("REC"),
            "amount": paid,
            "method": method,
            "note": pay_note,
        }
    return command("invoice.create", payload)


def sell(
    api: TestClient, customer_id: str, lines: list[tuple[str, int, int]], **extra: Any
) -> dict[str, Any]:
    return push_one(api, invoice_cmd(customer_id, lines, **extra))

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


def stock_in(api: TestClient, variant_id: str, qty: int, note: str | None = None) -> Any:
    return api.post(
        "/api/v1/stock/in",
        json={
            "note": note,
            "items": [{"id": str(uuid.uuid4()), "variant_id": variant_id, "qty": qty}],
        },
    )

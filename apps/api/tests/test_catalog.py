import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog, Product, ProductVariant
from tests import helpers
from tests.conftest import new_client

V1 = "/api/v1"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/categories"),
        ("POST", "/categories"),
        ("GET", "/products"),
        ("POST", "/products"),
        ("GET", f"/products/{uuid.uuid4()}"),
        ("GET", "/variants"),
        ("PATCH", f"/variants/{uuid.uuid4()}"),
        ("GET", f"/variants/{uuid.uuid4()}/movements"),
        ("GET", "/sync/pull"),
        ("POST", "/sync/push"),
    ],
)
def test_every_catalog_route_needs_a_session(method: str, path: str) -> None:
    with new_client() as c:
        assert c.request(method, V1 + path, json={}).status_code == 401


def test_writes_without_the_csrf_header_are_rejected(api: TestClient) -> None:
    r = api.post(V1 + "/categories", json={"name": "x"}, headers={"X-Requested-With": ""})
    assert r.status_code == 403
    assert r.json()["code"] == "CSRF_REJECTED"


def test_category_create_rename_deactivate(api: TestClient) -> None:
    c = helpers.category(api, "فحم")
    assert c["is_active"] is True
    r = api.patch(f"{V1}/categories/{c['id']}", json={"name": "الفحم"})
    assert r.status_code == 200 and r.json()["name"] == "الفحم"
    assert api.patch(f"{V1}/categories/{c['id']}", json={"is_active": False}).status_code == 200
    assert api.get(V1 + "/categories").json() == []
    assert len(api.get(V1 + "/categories?include_inactive=true").json()) == 1


def test_category_names_are_unique_after_normalization(api: TestClient) -> None:
    helpers.category(api, "أراجيل")
    r = api.post(V1 + "/categories", json={"name": "اراجيل"})  # same word, different hamza
    assert r.status_code == 409 and r.json()["code"] == "DUPLICATE_CATEGORY"


def test_product_with_variants_gets_generated_skus(api: TestClient) -> None:
    p = helpers.product(api)
    a = helpers.variant(api, p["id"], 4500, color="أسود", size="كبير")
    b = helpers.variant(api, p["id"], 5000, color="أحمر", size="كبير")
    assert a["sku"] == "SKU-000001" and b["sku"] == "SKU-000002"
    detail = api.get(f"{V1}/products/{p['id']}").json()
    assert [v["sku"] for v in detail["variants"]] == ["SKU-000001", "SKU-000002"]


def test_color_and_size_are_unique_within_a_product(api: TestClient) -> None:
    p = helpers.product(api)
    helpers.variant(api, p["id"], color="أسود", size="كبير")
    r = api.post(
        f"{V1}/products/{p['id']}/variants", json={"price": 1, "color": "أسود", "size": "كبير"}
    )
    assert r.status_code == 409 and r.json()["code"] == "DUPLICATE_VARIANT"
    # Another product may reuse the same color and size.
    other = helpers.product(api, "بربيش")
    helpers.variant(api, other["id"], color="أسود", size="كبير")


def test_two_variants_without_color_and_size_are_still_duplicates(api: TestClient) -> None:
    p = helpers.product(api)
    helpers.variant(api, p["id"])
    r = api.post(f"{V1}/products/{p['id']}/variants", json={"price": 7, "color": "  ", "size": ""})
    assert r.status_code == 409 and r.json()["code"] == "DUPLICATE_VARIANT"


def test_the_database_itself_refuses_duplicates(api: TestClient, db: Session) -> None:
    p = helpers.product(api)
    v = helpers.variant(api, p["id"])
    clone = db.get(ProductVariant, uuid.UUID(v["id"]))
    assert clone is not None
    db.add(
        ProductVariant(
            id=uuid.uuid4(),
            product_id=clone.product_id,
            sku="SKU-999999",
            price=1,
            created_at=clone.created_at,
            updated_at=clone.updated_at,
            change_seq=1,
        )
    )
    with pytest.raises(Exception, match="uq_variant_product_color_size"):
        db.commit()
    db.rollback()


def test_validation_errors_use_the_standard_shape(api: TestClient) -> None:
    p = helpers.product(api)
    for body in ({"price": -1}, {"price": 10**12}, {"price": 100, "min_stock": -1}, {"price": 1.5}):
        r = api.post(f"{V1}/products/{p['id']}/variants", json=body)
        assert r.status_code == 422, body
        assert r.json()["code"] == "VALIDATION_ERROR"
        assert r.json()["details"]["errors"]
    too_long = api.post(V1 + "/categories", json={"name": "x" * 201})
    assert too_long.status_code == 422


def test_price_change_is_audited(api: TestClient, db: Session) -> None:
    p = helpers.product(api)
    v = helpers.variant(api, p["id"], 4500)
    r = api.patch(f"{V1}/variants/{v['id']}", json={"price": 5000})
    assert r.status_code == 200 and r.json()["price"] == 5000
    entry = db.scalars(select(AuditLog).where(AuditLog.action == "price_change")).one()
    assert entry.before == {"price": 4500} and entry.after == {"price": 5000}


def test_deactivating_hides_but_keeps_history(api: TestClient) -> None:
    p = helpers.product(api)
    v = helpers.variant(api, p["id"], opening_qty=7)
    assert api.patch(f"{V1}/variants/{v['id']}", json={"is_active": False}).status_code == 200
    assert api.patch(f"{V1}/products/{p['id']}", json={"is_active": False}).status_code == 200
    assert api.get(V1 + "/products").json()["items"] == []
    assert api.get(V1 + "/variants").json()["items"] == []
    assert len(api.get(V1 + "/products?include_inactive=true").json()["items"]) == 1
    history = api.get(f"{V1}/variants/{v['id']}/movements").json()["items"]
    assert [m["type"] for m in history] == ["opening"]


def test_list_summarizes_each_product_in_one_query(api: TestClient) -> None:
    p = helpers.product(api)
    helpers.variant(api, p["id"], 1000, color="a", opening_qty=10, min_stock=2)
    helpers.variant(api, p["id"], 3000, color="b", opening_qty=2, min_stock=5)  # low
    helpers.variant(api, p["id"], 2000, color="c")  # out
    item = api.get(V1 + "/products").json()["items"][0]
    assert item["variant_count"] == 3
    assert (item["price_min"], item["price_max"]) == (1000, 3000)
    assert (item["stock_total"], item["low_count"], item["out_count"]) == (12, 1, 1)
    assert item["thumb_url"] is None


def test_product_list_search_uses_normalized_text(api: TestClient) -> None:
    cat = helpers.category(api, "أراجيل")
    helpers.product(api, "أرجيلة كبيرة", category_id=cat["id"])
    helpers.product(api, "فحم طبيعي")

    def names(q: str) -> list[str]:
        items = api.get(V1 + "/products", params={"q": q}).json()["items"]
        return [i["name"] for i in items]

    assert names("ارجيله") == ["أرجيلة كبيرة"]  # hamza, ة/ه
    assert names("اراجيل كبيره") == ["أرجيلة كبيرة"]  # category name + product, every word
    assert names("طبيعي فحم") == ["فحم طبيعي"]
    assert names("غير موجود") == []


def test_search_text_follows_variants_and_category_renames(api: TestClient, db: Session) -> None:
    cat = helpers.category(api, "فحم")
    p = helpers.product(api, "فحم طبيعي", category_id=cat["id"])
    helpers.variant(api, p["id"], color="أسود", size="٢٥ قطعة")
    row = db.get(Product, uuid.UUID(p["id"]))
    assert row is not None
    assert "اسود" in row.search_text and "25" in row.search_text and "sku 000001" in row.search_text
    api.patch(f"{V1}/categories/{cat['id']}", json={"name": "المشاعل"})
    db.refresh(row)
    assert "المشاعل" in row.search_text and "فحم طبيعي" in row.search_text
    api.patch(f"{V1}/products/{p['id']}", json={"description": "نكهة خاصة"})
    db.refresh(row)
    assert "نكهه خاصه" in row.search_text


def test_pagination_walks_every_product_once(api: TestClient) -> None:
    cat = helpers.category(api)
    for n in range(7):
        helpers.product(api, f"منتج {n}", category_id=cat["id"])
    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 3, **({"cursor": cursor} if cursor else {})}
        page = api.get(V1 + "/products", params=params).json()
        seen += [i["name"] for i in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if not cursor:
            break
    assert pages == 3 and seen == sorted(seen) and len(set(seen)) == 7
    assert api.get(V1 + "/products", params={"limit": 201}).status_code == 422
    assert api.get(V1 + "/products", params={"cursor": "garbage"}).status_code == 422


def test_variant_picker_lists_and_searches(api: TestClient) -> None:
    p = helpers.product(api, "بربيش")
    helpers.variant(api, p["id"], color="أسود")
    helpers.variant(api, p["id"], color="أحمر")
    items = api.get(V1 + "/variants", params={"q": "بربيش اسود"}).json()["items"]
    assert [i["color"] for i in items] == ["أسود", "أحمر"]  # product-level text: both match "بربيش"
    sku = api.get(V1 + "/variants", params={"q": "sku-000002"}).json()["items"]
    assert sku and all(i["product_name"] == "بربيش" for i in sku)


def test_unknown_ids_are_404_and_bad_category_is_422(api: TestClient) -> None:
    assert api.get(f"{V1}/products/{uuid.uuid4()}").status_code == 404
    assert api.patch(f"{V1}/variants/{uuid.uuid4()}", json={"price": 1}).status_code == 404
    r = api.post(V1 + "/products", json={"name": "x", "category_id": str(uuid.uuid4())})
    assert r.status_code == 422


def test_each_write_takes_one_change_seq_and_seqs_only_grow(api: TestClient, db: Session) -> None:
    p = helpers.product(api)
    v1 = helpers.variant(api, p["id"], color="a")
    v2 = helpers.variant(api, p["id"], color="b")
    row1 = db.get(ProductVariant, uuid.UUID(v1["id"]))
    row2 = db.get(ProductVariant, uuid.UUID(v2["id"]))
    assert row1 and row2 and row2.change_seq > row1.change_seq
    before = row2.change_seq
    api.patch(f"{V1}/variants/{v2['id']}", json={"price": 99})
    db.refresh(row2)
    assert row2.change_seq > before
    assert db.scalar(select(func.max(ProductVariant.change_seq))) == row2.change_seq

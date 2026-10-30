import io
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog, Category, Product, ProductVariant, StockMovement
from app.services.stock import stock_mismatches
from tests import helpers
from tests.conftest import new_client

URL = "/api/v1/import/products"
AR_HEADER = ["المنتج", "الفئة", "اللون", "الحجم", "السعر", "الكمية"]


def xlsx(rows: list[list[Any]], header: list[str] | None = None) -> bytes:
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(header or AR_HEADER)
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def post(
    api: TestClient, data: bytes, dry_run: bool = False, name: str = "p.xlsx"
) -> httpx.Response:
    response: httpx.Response = api.post(
        URL, params={"dry_run": str(dry_run).lower()}, files={"file": (name, data)}
    )
    return response


def counts(db: Session) -> tuple[int, int, int, int]:
    def n(model: Any) -> int:
        return int(db.scalar(select(func.count()).select_from(model)) or 0)

    return n(Category), n(Product), n(ProductVariant), n(StockMovement)


SAMPLE: list[list[Any]] = [
    ["أرجيلة كبيرة", "أراجيل", "أسود", "كبير", 450, 12],
    ["أرجيلة كبيرة", "أراجيل", "أحمر", "كبير", 450.5, 8],
    ["فحم طبيعي", "فحم", None, 25, 18.25, 100],
    ["بربيش", "بربيش", "أزرق", None, 9, None],  # no quantity: no opening movement
]


def test_needs_a_session() -> None:
    with new_client() as c:
        assert c.post(URL, files={"file": ("p.xlsx", b"x")}).status_code == 401


def test_a_valid_xlsx_creates_everything_with_the_exact_opening_stock(
    api: TestClient, db: Session
) -> None:
    r = post(api, xlsx(SAMPLE))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["committed"] is True and body["errors_total"] == 0
    assert (body["new_categories"], body["new_products"], body["new_variants"]) == (3, 3, 4)
    assert body["opening_units"] == 120
    assert counts(db) == (3, 3, 4, 3)  # three opening movements: the last row had no quantity

    rows = db.execute(
        select(
            Product.name,
            ProductVariant.color,
            ProductVariant.size,
            ProductVariant.price,
            ProductVariant.stock_qty,
        )
        .join(Product)
        .order_by(ProductVariant.sku)
    ).all()
    assert [tuple(r) for r in rows] == [
        ("أرجيلة كبيرة", "أسود", "كبير", 45000, 12),
        ("أرجيلة كبيرة", "أحمر", "كبير", 45050, 8),
        ("فحم طبيعي", None, "25", 1825, 100),  # a numeric size cell becomes the text "25"
        ("بربيش", "أزرق", None, 900, 0),
    ]
    assert [s for s in db.scalars(select(ProductVariant.sku).order_by(ProductVariant.sku))] == [
        "SKU-000001",
        "SKU-000002",
        "SKU-000003",
        "SKU-000004",
    ]
    assert stock_mismatches(db) == []
    entry = db.scalars(select(AuditLog).where(AuditLog.entity == "import")).one()
    assert entry.after is not None and entry.after["variants"] == 4


def test_the_new_catalog_is_searchable_right_away(api: TestClient) -> None:
    post(api, xlsx(SAMPLE))
    found = api.get("/api/v1/products", params={"q": "ارجيله اسود"}).json()["items"]
    assert [i["name"] for i in found] == ["أرجيلة كبيرة"]
    assert found[0]["stock_total"] == 20 and found[0]["variant_count"] == 2


def test_dry_run_reports_without_writing_and_matches_the_real_run(
    api: TestClient, db: Session
) -> None:
    dry = post(api, xlsx(SAMPLE), dry_run=True).json()
    assert dry["committed"] is False and counts(db) == (0, 0, 0, 0)
    assert len(dry["preview"]) == 4 and dry["preview"][0]["price"] == 45000
    real = post(api, xlsx(SAMPLE)).json()
    for key in ("new_categories", "new_products", "new_variants", "opening_units", "rows"):
        assert dry[key] == real[key], key


def test_csv_with_english_headers_semicolons_and_a_bom(api: TestClient, db: Session) -> None:
    lines = [
        "Product;Category;Colour;Size;Price;Qty",
        "Hose;Hoses;Black;;12,50;3",
        "Hose;Hoses;Red;;12.5;٤",
    ]
    text = "﻿" + "\n".join(lines) + "\n"
    r = post(api, text.encode("utf-8"), name="p.csv")
    assert r.status_code == 200, r.text
    assert r.json()["new_variants"] == 2
    prices = db.scalars(select(ProductVariant.price).order_by(ProductVariant.sku)).all()
    assert list(prices) == [1250, 1250]
    assert list(db.scalars(select(ProductVariant.stock_qty).order_by(ProductVariant.sku))) == [3, 4]


def test_csv_saved_in_windows_arabic_encoding(api: TestClient) -> None:
    data = "المنتج,الفئة,السعر\nأرجيلة,أراجيل,10\n".encode("cp1256")
    assert post(api, data, name="p.csv").json()["new_variants"] == 1


def test_arabic_digits_in_text_cells(api: TestClient) -> None:
    r = post(api, xlsx([["منتج", "فئة", None, "٢٥", "١٢٫٥٠", "٣٠"]]))
    assert r.status_code == 200, r.text
    assert r.json()["opening_units"] == 30


def test_every_bad_row_is_reported_with_its_row_number_and_nothing_is_saved(
    api: TestClient, db: Session
) -> None:
    rows: list[list[Any]] = [
        ["جيد", "فئة", None, None, 10, 1],  # row 2: fine
        ["", "فئة", None, None, 10, 1],  # row 3: no product name
        ["سعر سيء", "فئة", None, None, "abc", 1],  # row 4
        ["ثلاث خانات", "فئة", None, None, "1.234", 1],  # row 5
        ["سالب", "فئة", None, None, "-5", 1],  # row 6
        ["كمية سيئة", "فئة", None, None, 5, "1.5"],  # row 7
        ["بلا سعر", "فئة", None, None, None, 1],  # row 8
        ["طويل" * 80, "فئة", None, None, 5, 1],  # row 9
        ["مكرر", "فئة", "أسود", "كبير", 5, 1],  # row 10
        ["مكرر", "فئة", "اسود", "كبير", 6, 1],  # row 11: same variant, spelled with another hamza
    ]
    dry = post(api, xlsx(rows), dry_run=True).json()
    assert {(e["row"], e["field"], e["code"]) for e in dry["errors"]} == {
        (3, "product", "REQUIRED"),
        (4, "price", "BAD_PRICE"),
        (5, "price", "BAD_PRICE"),
        (6, "price", "BAD_PRICE"),
        (7, "qty", "BAD_QTY"),
        (8, "price", "REQUIRED"),
        (9, "product", "TOO_LONG"),
        (11, "color", "DUPLICATE_IN_FILE"),
    }
    assert [e for e in dry["errors"] if e["code"] == "DUPLICATE_IN_FILE"][0]["detail"] == "10"
    real = post(api, xlsx(rows))
    assert real.status_code == 422 and real.json()["code"] == "IMPORT_HAS_ERRORS"
    assert real.json()["details"]["errors_total"] == 8
    assert counts(db) == (0, 0, 0, 0)  # one bad row, nothing at all is saved


def test_blank_rows_are_skipped_but_row_numbers_stay_true(api: TestClient) -> None:
    rows: list[list[Any]] = [
        ["جيد", "فئة", None, None, 10, 1],
        [None] * 6,
        ["سيء", "فئة", None, None, "x", 1],
    ]
    errors = post(api, xlsx(rows), dry_run=True).json()["errors"]
    assert [e["row"] for e in errors] == [4]


def test_importing_again_never_touches_known_variants(api: TestClient, db: Session) -> None:
    post(api, xlsx(SAMPLE))
    first_stock = db.scalars(select(ProductVariant.stock_qty).order_by(ProductVariant.sku)).all()
    changed = [[*row[:4], 9999, 5] for row in SAMPLE]
    again = post(api, xlsx(changed)).json()
    assert (again["new_variants"], again["skipped_existing"]) == (0, 4)
    db.expire_all()
    assert list(db.scalars(select(ProductVariant.stock_qty).order_by(ProductVariant.sku))) == list(
        first_stock
    )
    assert 9999 * 100 not in db.scalars(select(ProductVariant.price)).all()
    assert counts(db) == (3, 3, 4, 3)


def test_a_new_color_of_a_known_product_joins_it(api: TestClient, db: Session) -> None:
    post(api, xlsx(SAMPLE))
    r = post(api, xlsx([["أرجيلة كبيرة", "أراجيل", "أخضر", "كبير", 460, 2]])).json()
    assert (r["new_products"], r["new_variants"], r["new_categories"]) == (0, 1, 0)
    assert counts(db) == (3, 3, 5, 4)


def test_same_product_name_in_another_category_is_another_product(
    api: TestClient, db: Session
) -> None:
    r = post(api, xlsx([["رأس", "طين", None, None, 5, 1], ["رأس", "زجاج", None, None, 6, 1]]))
    assert r.json()["new_products"] == 2


def test_inactive_categories_and_products_block_their_rows(api: TestClient) -> None:
    cat = helpers.category(api, "قديمة")
    api.patch(f"/api/v1/categories/{cat['id']}", json={"is_active": False})
    errors = post(api, xlsx([["س", "قديمة", None, None, 1, 1]]), dry_run=True).json()["errors"]
    assert errors[0]["code"] == "CATEGORY_INACTIVE"


def test_columns_are_recognized_by_name_in_any_order_and_extras_are_listed(api: TestClient) -> None:
    header = ["ملاحظات", "السعر", "الفئة", "الصنف", "الكميه"]
    rows = [["x", 7, "فئة", "منتج", 3]]
    body = post(api, xlsx(rows, header), dry_run=True).json()
    assert body["errors"] == []
    assert body["ignored_columns"] == ["ملاحظات"]
    assert body["mapped_columns"]["qty"] == "الكميه"


def test_a_missing_required_column_is_one_clear_error(api: TestClient) -> None:
    body = post(api, xlsx([["a", "b"]], ["المنتج", "الفئة"]), dry_run=True).json()
    assert [(e["field"], e["code"]) for e in body["errors"]] == [("price", "MISSING_COLUMN")]


@pytest.mark.parametrize(
    ("data", "status", "code"),
    [
        (b"", 422, "IMPORT_EMPTY"),
        (b"PK\x03\x04 not really a zip", 422, "IMPORT_UNREADABLE"),
        (b"\xd0\xcf\x11\xe0" + b"\x00" * 20, 422, "IMPORT_OLD_EXCEL"),
        (b"a" * (5 * 1024 * 1024 + 1), 413, "IMPORT_TOO_LARGE"),
    ],
)
def test_unusable_files(api: TestClient, data: bytes, status: int, code: str) -> None:
    r = post(api, data)
    assert (r.status_code, r.json()["code"]) == (status, code)


def test_a_few_hundred_rows(api: TestClient, db: Session) -> None:
    rows = [
        [f"منتج {n}", f"فئة {n % 7}", f"لون {k}", None, 10 + k, k + 1]
        for n in range(120)
        for k in range(3)
    ]
    r = post(api, xlsx(rows))
    assert r.status_code == 200 and r.json()["new_variants"] == 360
    assert counts(db) == (7, 120, 360, 360)
    assert stock_mismatches(db) == []

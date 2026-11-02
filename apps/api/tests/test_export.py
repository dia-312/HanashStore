"""The export (SPEC F13): every file, the numbers in it, and nothing a spreadsheet would run."""

import csv
import io
import zipfile
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLog, Invoice, InvoiceLine, Payment, Return, StockMovement
from app.services import export
from tests import helpers

FILES = {
    "README.txt",
    "customers.csv",
    "categories.csv",
    "products.csv",
    "variants.csv",
    "invoices.csv",
    "invoice_lines.csv",
    "payments.csv",
    "returns.csv",
    "return_lines.csv",
    "stock_movements.csv",
}


def download(api: TestClient) -> zipfile.ZipFile:
    r = api.get("/api/v1/export")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith('attachment; filename="hanash-export-')
    assert r.headers["cache-control"] == "no-store"
    return zipfile.ZipFile(io.BytesIO(r.content))


def rows(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    raw = archive.read(name)
    assert raw.startswith(b"\xef\xbb\xbf"), f"{name} has no byte-order mark: Excel garbles Arabic"
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))


def shop(api: TestClient) -> dict[str, Any]:
    cid = helpers.customer(api, name="محل النور", shop_name="سوبرماركت", opening_balance=1500)
    product = helpers.product(api, "أرجيلة كبيرة")
    var = helpers.variant(api, product["id"], price=1000, color="أسود", size="كبير")["id"]
    helpers.stock_in(api, var, 20)
    sale = helpers.invoice_cmd(
        cid,
        [(var, 3, 1000)],
        discount=100,
        paid=1000,
        issued_at="2026-10-30T10:00:00Z",
        pay_note="x",
    )
    assert helpers.push_one(api, sale)["status"] == "applied"
    assert (
        helpers.push_one(api, helpers.return_cmd(sale, [(0, 1, "damaged")]))["status"] == "applied"
    )
    pay = helpers.payment_cmd(cid, 300)
    assert helpers.push_one(api, pay)["status"] == "applied"
    assert (
        helpers.push_one(api, helpers.void_cmd(pay["payload"]["payment_id"]))["status"] == "applied"
    )
    assert helpers.push_one(api, helpers.refund_cmd(cid, 100))["status"] == "applied"
    return {"customer": cid, "variant": var, "sale": sale}


def test_needs_a_session(client: TestClient) -> None:
    assert client.get("/api/v1/export").status_code == 401


def test_the_zip_has_every_file_with_a_byte_order_mark(api: TestClient) -> None:
    shop(api)
    archive = download(api)
    assert set(archive.namelist()) == FILES
    for name in FILES - {"README.txt"}:
        rows(archive, name)  # asserts the BOM
    assert "UTF-8" in archive.read("README.txt").decode("utf-8-sig")


def test_what_is_in_the_files(api: TestClient) -> None:
    shop(api)
    archive = download(api)

    [customer] = rows(archive, "customers.csv")
    assert customer["name"] == "محل النور" and customer["shop"] == "سوبرماركت"
    assert customer["opening_balance_ils"] == "15.00"
    # 15.00 + 29.00 - 9.66 (return) - 10.00 (paid) + 1.00 (refund); the voided 3.00 is out
    assert customer["balance_ils"] == "25.34"
    assert customer["active"] == "نعم"

    [invoice] = rows(archive, "invoices.csv")
    assert invoice["date"] == "2026-10-30 12:00"  # 10:00Z is noon in Hebron (UTC+2 after 24/10)
    assert (invoice["subtotal_ils"], invoice["discount_ils"], invoice["total_ils"]) == (
        "30.00",
        "1.00",
        "29.00",
    )
    assert invoice["paid_ils"] == "10.00" and invoice["status"] == "مؤكدة"

    [line] = rows(archive, "invoice_lines.csv")
    assert line["invoice"] == invoice["number"] and line["variant"] == "أسود · كبير"
    assert (line["qty"], line["unit_price_ils"], line["line_total_ils"]) == ("3", "10.00", "30.00")

    payments = {p["number"]: p for p in rows(archive, "payments.csv")}
    assert sorted(p["kind"] for p in payments.values()) == ["استرداد", "دفعة", "دفعة"]
    voided = [p for p in payments.values() if p["status"] == "ملغاة"]
    assert len(voided) == 1 and voided[0]["amount_ils"] == "3.00" and voided[0]["void_reason"]

    [ret] = rows(archive, "returns.csv")
    assert ret["total_ils"] == "9.66" and ret["invoice"] == invoice["number"]
    [ret_line] = rows(archive, "return_lines.csv")
    assert ret_line["disposition"] == "تالف" and ret_line["variant"] == "أسود · كبير"
    assert ret_line["amount_ils"] == "9.66"

    [variant] = rows(archive, "variants.csv")
    assert variant["stock"] == "17" and variant["price_ils"] == "10.00"
    kinds = [m["type"] for m in rows(archive, "stock_movements.csv")]
    assert sorted(kinds) == ["purchase", "sale"]


def test_a_cancelled_invoice_is_there_and_marked(api: TestClient) -> None:
    info = shop(api)
    cmd = helpers.invoice_cmd(info["customer"], [(info["variant"], 1, 1000)])
    assert helpers.push_one(api, cmd)["status"] == "applied"
    cancel = helpers.command(
        "invoice.cancel",
        {
            "invoice_id": cmd["payload"]["invoice_id"],
            "cancelled_at": "2026-11-02T09:00:00Z",
            "reason": "طلب الزبون",
            "void_payment": False,
            "lines": [],
        },
    )
    assert helpers.push_one(api, cancel)["status"] == "applied"
    by_number = {i["number"]: i for i in rows(download(api), "invoices.csv")}
    cancelled = by_number[cmd["payload"]["number"]]
    assert cancelled["status"] == "ملغاة" and cancelled["cancel_reason"] == "طلب الزبون"


@pytest.mark.parametrize("evil", ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)"])
def test_text_that_a_spreadsheet_would_run_is_made_harmless(api: TestClient, evil: str) -> None:
    helpers.customer(api, name=evil, notes=evil)
    [customer] = rows(download(api), "customers.csv")
    assert customer["name"] == "'" + evil and customer["notes"] == "'" + evil


def test_ordinary_text_is_not_touched() -> None:
    assert export.text_cell("محل النور") == "محل النور"
    assert export.text_cell(None) == ""
    assert export.text_cell("12-3") == "12-3"
    assert export.ils(-5) == "-0.05" and export.ils(100000) == "1000.00" and export.ils(None) == ""


def test_commas_and_quotes_survive_the_csv(api: TestClient) -> None:
    # (the app keeps a customer's text on one line: a line break is a space by the time it is saved)
    note = 'قال: "ادفع، لاحقاً" سطر ثانٍ'
    helpers.customer(api, name="زبون, فاصلة", notes=note)
    [customer] = rows(download(api), "customers.csv")
    assert customer["name"] == "زبون, فاصلة" and customer["notes"] == note


def test_an_empty_database_still_gives_a_valid_zip(api: TestClient) -> None:
    archive = download(api)
    assert set(archive.namelist()) == FILES
    assert rows(archive, "customers.csv") == [] and rows(archive, "invoices.csv") == []


def test_the_download_is_audited(api: TestClient, db: Session) -> None:
    shop(api)
    download(api)
    entry = db.scalars(select(AuditLog).where(AuditLog.entity == "export")).one()
    assert entry.after is not None and entry.after["invoices.csv"] == 1


def test_the_files_match_the_database_row_for_row(api: TestClient, db: Session) -> None:
    shop(api)
    archive = download(api)
    db.rollback()
    for name, model in (
        ("invoices.csv", Invoice),
        ("invoice_lines.csv", InvoiceLine),
        ("payments.csv", Payment),
        ("returns.csv", Return),
        ("stock_movements.csv", StockMovement),
    ):
        assert len(rows(archive, name)) == db.scalar(select(func.count()).select_from(model)), name
    total = sum(int(round(float(r["total_ils"]) * 100)) for r in rows(archive, "invoices.csv"))
    assert total == db.scalar(select(func.sum(Invoice.total)))

"""Export of all the data as a ZIP of CSV files (SPEC F13), for the rep to keep or open in Excel.

Text is UTF-8 with a byte-order mark (Excel reads Arabic correctly only with it). Money is in
shekels with two decimals ("12.50"), dates are Hebron time `yyyy-MM-dd HH:mm`, and a text cell that
starts with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet never runs it as a
formula. Every row carries what a person needs to read it (names, numbers), not only ids.
"""

import csv
import io
import zipfile
from collections.abc import Iterable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.models import (
    Category,
    Customer,
    Invoice,
    InvoiceLine,
    Payment,
    Product,
    ProductVariant,
    Return,
    ReturnLine,
    StockMovement,
)
from app.services import customers

HEBRON = ZoneInfo("Asia/Hebron")
BOM = "﻿"
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def ils(agorot: int | None) -> str:
    if agorot is None:
        return ""
    sign = "-" if agorot < 0 else ""
    whole, cents = divmod(abs(agorot), 100)
    return f"{sign}{whole}.{cents:02d}"


def when(moment: datetime | None) -> str:
    return moment.astimezone(HEBRON).strftime("%Y-%m-%d %H:%M") if moment else ""


def text_cell(value: Any) -> str:
    """A cell as text; one that could be read as a formula is made harmless."""
    if value is None:
        return ""
    cell = str(value)
    return "'" + cell if cell.startswith(_FORMULA_START) else cell


def yes(flag: bool) -> str:
    return "نعم" if flag else "لا"


def _csv(header: list[str], rows: Iterable[list[str]]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(header)
    writer.writerows(rows)
    return (BOM + out.getvalue()).encode("utf-8")


def build(db: Session) -> tuple[bytes, dict[str, int]]:
    """The ZIP and how many rows each file has."""
    cats = {c.id: c for c in db.scalars(select(Category))}
    products = {p.id: p for p in db.scalars(select(Product))}
    variants = {v.id: v for v in db.scalars(select(ProductVariant))}
    custs = list(db.scalars(select(Customer).order_by(Customer.name, Customer.id)))
    cust_name = {c.id: c.name for c in custs}
    balance = customers.balances(db, [c.id for c in custs])
    invoices = list(db.scalars(select(Invoice).order_by(Invoice.issued_at, Invoice.number)))
    invoice_number = {i.id: i.number for i in invoices}
    lines = list(
        db.scalars(select(InvoiceLine).order_by(InvoiceLine.invoice_id, InvoiceLine.sort_order))
    )
    line_variant = {ln.id: ln.variant_id for ln in lines}
    paid_on: dict[Any, int] = {}
    payments = list(db.scalars(select(Payment).order_by(Payment.paid_at, Payment.number)))
    for p in payments:
        if p.invoice_id and p.status == "active" and p.kind == "payment":
            paid_on[p.invoice_id] = paid_on.get(p.invoice_id, 0) + p.amount
    returns = list(db.scalars(select(Return).order_by(Return.issued_at, Return.number)))
    return_number = {r.id: r.number for r in returns}
    return_invoice = {r.id: r.invoice_id for r in returns}
    return_lines = list(db.scalars(select(ReturnLine)))
    movements = list(db.scalars(select(StockMovement).order_by(StockMovement.created_at)))

    def variant_label(variant_id: Any) -> tuple[str, str]:
        v = variants.get(variant_id)
        if v is None:
            return "", ""
        p = products.get(v.product_id)
        return (p.name if p else ""), " · ".join(x for x in (v.color, v.size) if x)

    files: dict[str, tuple[list[str], list[list[str]]]] = {
        "customers.csv": (
            [
                "id",
                "name",
                "shop",
                "phone",
                "area",
                "address",
                "notes",
                "opening_balance_ils",
                "balance_ils",
                "active",
            ],
            [
                [
                    str(c.id),
                    text_cell(c.name),
                    text_cell(c.shop_name),
                    text_cell(c.phone),
                    text_cell(c.area),
                    text_cell(c.address),
                    text_cell(c.notes),
                    ils(c.opening_balance),
                    ils(balance.get(c.id, c.opening_balance)),
                    yes(c.is_active),
                ]
                for c in custs
            ],
        ),
        "categories.csv": (
            ["id", "name", "active"],
            [[str(c.id), text_cell(c.name), yes(c.is_active)] for c in cats.values()],
        ),
        "products.csv": (
            ["id", "name", "category", "description", "active"],
            [
                [
                    str(p.id),
                    text_cell(p.name),
                    text_cell(cats[p.category_id].name if p.category_id in cats else ""),
                    text_cell(p.description),
                    yes(p.is_active),
                ]
                for p in sorted(products.values(), key=lambda p: (p.name, str(p.id)))
            ],
        ),
        "variants.csv": (
            [
                "id",
                "sku",
                "product",
                "category",
                "color",
                "size",
                "price_ils",
                "min_stock",
                "stock",
                "active",
            ],
            [
                [
                    str(v.id),
                    v.sku,
                    text_cell(products[v.product_id].name),
                    text_cell(cats[products[v.product_id].category_id].name),
                    text_cell(v.color),
                    text_cell(v.size),
                    ils(v.price),
                    str(v.min_stock),
                    str(v.stock_qty),
                    yes(v.is_active),
                ]
                for v in sorted(
                    variants.values(), key=lambda v: (products[v.product_id].name, v.sku)
                )
            ],
        ),
        "invoices.csv": (
            [
                "number",
                "date",
                "customer",
                "status",
                "subtotal_ils",
                "discount_ils",
                "total_ils",
                "paid_ils",
                "delivered_at",
                "cancelled_at",
                "cancel_reason",
                "note",
            ],
            [
                [
                    i.number,
                    when(i.issued_at),
                    text_cell(cust_name.get(i.customer_id)),
                    "ملغاة" if i.status == "cancelled" else "مؤكدة",
                    ils(i.subtotal),
                    ils(i.discount),
                    ils(i.total),
                    ils(paid_on.get(i.id, 0)),
                    when(i.delivered_at),
                    when(i.cancelled_at),
                    text_cell(i.cancel_reason),
                    text_cell(i.note),
                ]
                for i in invoices
            ],
        ),
        "invoice_lines.csv": (
            [
                "invoice",
                "product",
                "variant",
                "qty",
                "unit_price_ils",
                "line_total_ils",
                "discount_share_ils",
            ],
            [
                [
                    invoice_number.get(ln.invoice_id, ""),
                    text_cell(ln.product_name),
                    text_cell(ln.variant_label),
                    str(ln.qty),
                    ils(ln.unit_price),
                    ils(ln.line_total),
                    ils(ln.discount_share),
                ]
                for ln in lines
            ],
        ),
        "payments.csv": (
            [
                "number",
                "kind",
                "date",
                "customer",
                "invoice",
                "method",
                "amount_ils",
                "status",
                "voided_at",
                "void_reason",
                "note",
            ],
            [
                [
                    p.number,
                    "استرداد" if p.kind == "refund" else "دفعة",
                    when(p.paid_at),
                    text_cell(cust_name.get(p.customer_id)),
                    invoice_number.get(p.invoice_id, "") if p.invoice_id else "",
                    p.method,
                    ils(p.amount),
                    "ملغاة" if p.status == "voided" else "فعّالة",
                    when(p.voided_at),
                    text_cell(p.void_reason),
                    text_cell(p.note),
                ]
                for p in payments
            ],
        ),
        "returns.csv": (
            ["number", "date", "customer", "invoice", "total_ils", "reason"],
            [
                [
                    r.number,
                    when(r.issued_at),
                    text_cell(cust_name.get(r.customer_id)),
                    invoice_number.get(r.invoice_id, ""),
                    ils(r.total),
                    text_cell(r.reason),
                ]
                for r in returns
            ],
        ),
        "return_lines.csv": (
            ["return", "invoice", "product", "variant", "qty", "disposition", "amount_ils"],
            [
                [
                    return_number.get(x.return_id, ""),
                    invoice_number.get(return_invoice[x.return_id], "")
                    if x.return_id in return_invoice
                    else "",
                    *(text_cell(t) for t in variant_label(line_variant.get(x.invoice_line_id))),
                    str(x.qty),
                    "أُعيد للمخزون" if x.disposition == "restock" else "تالف",
                    ils(x.amount),
                ]
                for x in return_lines
            ],
        ),
        "stock_movements.csv": (
            ["date", "product", "variant", "type", "qty", "note"],
            [
                [
                    when(m.created_at),
                    *(text_cell(t) for t in variant_label(m.variant_id)),
                    m.type,
                    str(m.qty),
                    text_cell(m.note),
                ]
                for m in movements
            ],
        ),
    }

    readme = (
        BOM
        + "بيانات المبيعات - تصدير كامل\r\n"
        + f"تاريخ التصدير: {when(clock.utcnow())} (توقيت الخليل)\r\n\r\n"
        + "كل ملف CSV بترميز UTF-8 ويفتح في Excel. المبالغ بالشيكل بمنزلتين عشريتين،\r\n"
        + "والتواريخ yyyy-MM-dd HH:mm. الرصيد الموجب = على الزبون، والسالب = له.\r\n"
        + "الفواتير الملغاة والدفعات الملغاة موجودة ومعلَّمة، ولا تُحسب في الأرصدة.\r\n"
    ).encode("utf-8")

    counts: dict[str, int] = {}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.txt", readme)
        for name, (header, rows) in files.items():
            archive.writestr(name, _csv(header, rows))
            counts[name] = len(rows)
    return buffer.getvalue(), counts

"""What goes on an invoice and a statement (SPEC sections 7 and 11).

The functions here turn database rows into a plain "document model": every amount and date is
already text (`₪ 1,250.00`, `29/10/2026 14:30`), so the Jinja template only lays it out. The device
builds the same model in `apps/web/src/lib/documents.ts` and both are tested against the same
fixtures. Flagged for line-by-line review: money."""

import json
import os
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import Customer, Invoice, InvoiceLine, Payment
from app.services import billing
from app.services import settings as settings_service
from app.services.statement import Statement

HEBRON = ZoneInfo("Asia/Hebron")
# In Docker the folder is mounted and named by SHARED_DIR; on a developer machine it is the repo's.
SHARED_DIR = (
    Path(os.environ["SHARED_DIR"])
    if "SHARED_DIR" in os.environ
    else Path(__file__).resolve().parents[4] / "shared"
)
LABELS: dict[str, dict[str, str]] = json.loads(
    (SHARED_DIR / "documents_labels.json").read_text(encoding="utf-8")
)


def money(agorot: int) -> str:
    """`₪ 1,250.00`, in whole integers: never through floats."""
    sign = "-" if agorot < 0 else ""
    whole, cents = divmod(abs(agorot), 100)
    return f"{sign}₪ {whole:,}.{cents:02d}"


def stamp(moment: datetime) -> str:
    """`dd/MM/yyyy HH:mm` in Asia/Hebron with Latin digits."""
    return moment.astimezone(HEBRON).strftime("%d/%m/%Y %H:%M")


def day(value: date) -> str:
    return value.strftime("%d/%m/%Y")


def business(db: Session) -> dict[str, Any]:
    values = settings_service.get_all(db)
    return {
        "name": values["business_name"],
        "phone": values["phone"],
        "footer": values["invoice_footer"],
        "logo_url": values["logo_url"],
    }


def _customer(customer: Customer) -> dict[str, Any]:
    return {"name": customer.name, "shop_name": customer.shop_name, "phone": customer.phone}


def invoice_document(db: Session, invoice_id: uuid.UUID) -> dict[str, Any]:
    invoice = db.get(Invoice, invoice_id)
    if invoice is None:
        raise ApiError(404, "NOT_FOUND", "Invoice not found")
    customer = db.get(Customer, invoice.customer_id)
    assert customer is not None
    lines = db.scalars(
        select(InvoiceLine)
        .where(InvoiceLine.invoice_id == invoice.id)
        .order_by(InvoiceLine.sort_order)
    ).all()
    paid = sum(
        p.amount
        for p in db.scalars(
            select(Payment).where(Payment.invoice_id == invoice.id, Payment.status == "active")
        )
    )
    return {
        "business": business(db),
        "number": invoice.number,
        "issued_at": stamp(invoice.issued_at),
        "cancelled": invoice.status == "cancelled",
        "cancel_reason": invoice.cancel_reason,
        "customer": _customer(customer),
        "lines": [
            {
                "n": i + 1,
                "product": line.product_name,
                "variant": line.variant_label,
                "qty": line.qty,
                "unit_price": money(line.unit_price),
                "line_total": money(line.line_total),
            }
            for i, line in enumerate(lines)
        ],
        "totals": {
            "subtotal": money(invoice.subtotal),
            "discount": money(invoice.discount) if invoice.discount > 0 else None,
            "total": money(invoice.total),
            "paid": money(paid),
            "remaining": money(billing.remaining_on_invoice(invoice.total, paid)),
        },
        "note": invoice.note,
    }


def statement_document(
    db: Session, customer: Customer, data: Statement, date_from: date, date_to: date
) -> dict[str, Any]:
    labels = LABELS["statement"]
    rows: list[dict[str, Any]] = []
    for row in data.rows:
        if row.kind == "opening":
            label = labels["opening"]
        elif row.kind == "invoice":
            label = labels["invoice"] + (" " + labels["cancelled"] if row.off else "")
        else:
            label = labels["voided"] if row.off else labels["payment"]
        when = date_from if row.kind == "opening" else row.moment.astimezone(HEBRON).date()
        rows.append(
            {
                "date": day(when),
                "label": label,
                "number": row.ref or None,
                "debit": money(row.debit) if row.debit else None,
                "credit": money(row.credit) if row.credit else None,
                "balance": money(row.balance),
                "css": "opening" if row.kind == "opening" else ("off" if row.off else ""),
            }
        )
    return {
        "business": business(db),
        "customer": _customer(customer),
        "period": {"from": day(date_from), "to": day(date_to)},
        "rows": rows,
        "totals": {
            "debit": money(data.total_debit),
            "credit": money(data.total_credit),
            "closing": money(data.closing),
        },
    }

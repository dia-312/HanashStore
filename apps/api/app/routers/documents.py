"""Invoice PDF, customer statement and its PDF (SPEC section 12)."""

import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app import clock
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.models import Customer
from app.services import documents, pdf, statement
from app.services.documents import HEBRON

router = APIRouter(tags=["documents"])


def _pdf_response(content: bytes, name: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{name}"', "Cache-Control": "no-store"},
    )


@router.get("/invoices/{invoice_id}/pdf")
def invoice_pdf(
    invoice_id: uuid.UUID,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> Response:
    doc = documents.invoice_document(db, invoice_id)
    return _pdf_response(pdf.render_pdf("invoice.html", doc, "invoice"), f"{doc['number']}.pdf")


def _period(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    today = clock.utcnow().astimezone(HEBRON).date()
    default_from, default_to = statement.default_period(today)
    start, end = date_from or default_from, date_to or default_to
    if start > end:
        raise ApiError(422, "VALIDATION_ERROR", "The period starts after it ends")
    return start, end


@router.get("/customers/{customer_id}/statement")
def statement_rows(
    customer_id: uuid.UUID,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    include_cancelled: bool = False,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    start, end = _period(date_from, date_to)
    data = statement.build(db, customer_id, start, end, include_cancelled)
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "rows": [
            {
                "kind": r.kind,
                "at": r.moment.isoformat(),
                "ref": r.ref,
                "debit": r.debit,
                "credit": r.credit,
                "off": r.off,
                "balance": r.balance,
            }
            for r in data.rows
        ],
        "total_debit": data.total_debit,
        "total_credit": data.total_credit,
        "closing": data.closing,
    }


@router.get("/customers/{customer_id}/statement.pdf")
def statement_pdf(
    customer_id: uuid.UUID,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    include_cancelled: bool = False,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> Response:
    start, end = _period(date_from, date_to)
    data = statement.build(db, customer_id, start, end, include_cancelled)
    customer = db.get(Customer, customer_id)
    assert customer is not None  # statement.build already raised 404 otherwise
    doc = documents.statement_document(db, customer, data, start, end)
    content = pdf.render_pdf("statement.html", doc, "statement")
    return _pdf_response(content, f"statement-{start.isoformat()}-{end.isoformat()}.pdf")

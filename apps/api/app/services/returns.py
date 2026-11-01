"""Returns: items a customer gives back from an invoice (SPEC sections 4 F11 and 7).

Flagged for line-by-line review: money, stock.

A return is written once and never edited. Each line says how many units come back and whether
they go back on the shelf (`restock`, one `return` movement) or are written off (`damaged`, no
movement). The customer is credited either way. The amount of every line is worked out here from
the invoice line; the device's own numbers are only a preview. Everything runs inside the caller's
transaction (one command = one transaction).
"""

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.models import Customer, Device, Invoice, InvoiceLine, Return, ReturnLine
from app.schemas import ReturnCreatePayload
from app.services import billing, customers, stock

# Same idea as invoices: the movement id comes from the return line, so applying a return twice
# could never put the goods on the shelf twice.
_NS = uuid.UUID("5d0e8e3a-6a0b-4b0b-9c1e-4f7e2f4e6a11")


def _movement_id(return_line_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(_NS, f"return:{return_line_id}")


def returned_so_far(
    db: Session, invoice_line_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, int]]:
    """For each invoice line: (units already returned, credit already given)."""
    if not invoice_line_ids:
        return {}
    rows = db.execute(
        select(ReturnLine.invoice_line_id, func.sum(ReturnLine.qty), func.sum(ReturnLine.amount))
        .where(ReturnLine.invoice_line_id.in_(invoice_line_ids))
        .group_by(ReturnLine.invoice_line_id)
    )
    return {row[0]: (int(row[1]), int(row[2])) for row in rows}


def create_return(
    db: Session, device: Device, body: ReturnCreatePayload, seq: int
) -> dict[str, Any]:
    invoice = db.execute(
        select(Invoice)
        .where(Invoice.id == body.invoice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if invoice is None:
        raise ApiError(
            409, "INVOICE_NOT_FOUND", "Invoice not found", {"invoice_id": str(body.invoice_id)}
        )
    if invoice.status == "cancelled":
        raise ApiError(409, "INVOICE_CANCELLED", "Nothing can be returned from a cancelled invoice")
    if (
        db.get(Return, body.return_id) is not None
        or db.scalar(select(Return.id).where(Return.number == body.number)) is not None
    ):
        raise ApiError(
            409, "DUPLICATE_NUMBER", "Return number already used", {"number": body.number}
        )
    # A stopped customer may still bring goods back. The row exists: the invoice points at it.
    customer = db.get(Customer, invoice.customer_id)
    assert customer is not None

    wanted_ids = [line.invoice_line_id for line in body.lines]
    if len(set(wanted_ids)) != len(wanted_ids):
        raise ApiError(422, "VALIDATION_ERROR", "A line of the invoice can appear only once")
    invoice_lines = {
        line.id: line
        for line in db.scalars(select(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id))
    }
    for line in body.lines:
        if line.invoice_line_id not in invoice_lines:
            raise ApiError(
                409,
                "LINE_NOT_ON_INVOICE",
                "This line is not on that invoice",
                {"invoice_line_id": str(line.invoice_line_id)},
            )
    done = returned_so_far(db, wanted_ids)

    amounts: list[int] = []
    for line in body.lines:
        sold = invoice_lines[line.invoice_line_id]
        already_qty, already_amount = done.get(line.invoice_line_id, (0, 0))
        if line.qty > sold.qty - already_qty:
            raise ApiError(
                409,
                "QTY_EXCEEDS_SOLD",
                "More than what is left to return on this line",
                {
                    "invoice_line_id": str(sold.id),
                    "sold": sold.qty,
                    "already_returned": already_qty,
                    "requested": line.qty,
                },
            )
        amounts.append(
            billing.return_line_amount(
                sold.line_total,
                sold.discount_share,
                sold.qty,
                already_qty,
                already_amount,
                line.qty,
            )
        )

    restocked = sorted(
        {
            invoice_lines[item.invoice_line_id].variant_id
            for item in body.lines
            if item.disposition == "restock"
        },
        key=str,
    )
    for variant_id in restocked:
        stock.lock_variant(db, variant_id)

    now = clock.utcnow()
    total = sum(amounts)
    db.add(
        Return(
            id=body.return_id,
            number=body.number,
            customer_id=customer.id,
            invoice_id=invoice.id,
            reason=body.reason or None,
            total=total,
            issued_at=body.issued_at,
            device_id=device.id,
            created_at=now,
            change_seq=seq,
        )
    )
    db.flush()  # the return row first: its lines point at it
    for line, amount in zip(body.lines, amounts, strict=True):
        db.add(
            ReturnLine(
                id=line.return_line_id,
                return_id=body.return_id,
                invoice_line_id=line.invoice_line_id,
                qty=line.qty,
                disposition=line.disposition,
                amount=amount,
                change_seq=seq,
            )
        )
        if line.disposition == "restock":
            stock.apply_movement(
                db,
                movement_id=_movement_id(line.return_line_id),
                variant_id=invoice_lines[line.invoice_line_id].variant_id,
                qty=line.qty,
                type="return",
                seq=seq,
                note=body.reason or None,
                device_id=device.id,
                ref_type="return",
                ref_id=body.return_id,
            )
    customers.touch(customer, seq)
    audit(
        db,
        "return",
        body.return_id,
        "create",
        after={
            "number": body.number,
            "invoice": invoice.number,
            "total": total,
            "lines": len(body.lines),
        },
        device_id=device.id,
    )
    db.flush()
    return {
        "return_id": str(body.return_id),
        "number": body.number,
        "customer_id": str(customer.id),
        "total": total,
        "amounts": {
            str(line.return_line_id): a for line, a in zip(body.lines, amounts, strict=True)
        },
        "customer_balance": customers.balance_of(db, customer.id),
        "variants": stock.variant_states(db, restocked),
    }

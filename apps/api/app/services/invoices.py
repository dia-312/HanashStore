"""Invoices: confirm, deliver, cancel (SPEC section 7).

Flagged for line-by-line review: money, stock.

An invoice is written once and never edited: only `delivered_at` and the cancellation change.
Everything here runs inside the caller's transaction (one command = one transaction).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.models import (
    Customer,
    Device,
    Invoice,
    InvoiceLine,
    Payment,
    Product,
    ProductVariant,
)
from app.schemas import CancelPayload, InvoiceCreatePayload, MarkDeliveredPayload
from app.services import billing, customers, stock

# Movement ids come from the line id, so applying the same invoice twice could never write a
# sale twice (the stock service ignores a movement id it has already seen).
_NS = uuid.UUID("5d0e8e3a-6a0b-4b0b-9c1e-4f7e2f4e6a10")


def _movement_id(kind: str, line_id: uuid.UUID) -> uuid.UUID:
    return uuid.uuid5(_NS, f"{kind}:{line_id}")


def _label(variant: ProductVariant) -> str:
    return " · ".join(part for part in (variant.color, variant.size) if part)


def _get_customer(db: Session, customer_id: uuid.UUID) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise ApiError(
            409, "CUSTOMER_NOT_FOUND", "Customer not found", {"customer_id": str(customer_id)}
        )
    return customer


def create_invoice(
    db: Session, device: Device, body: InvoiceCreatePayload, seq: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Returns (result data, warnings). Totals sent by the device are never trusted: there are
    none in the payload, the server works them all out."""
    customer = _get_customer(db, body.customer_id)
    if not customer.is_active:
        raise ApiError(409, "CUSTOMER_INACTIVE", "This customer is stopped")
    if db.get(Invoice, body.invoice_id) is not None:
        raise ApiError(409, "INVOICE_EXISTS", "This invoice was already created")
    if db.scalar(select(Invoice.id).where(Invoice.number == body.number)) is not None:
        raise ApiError(
            409, "DUPLICATE_NUMBER", "Invoice number already used", {"number": body.number}
        )
    payment = body.payment
    if payment is not None and (
        db.get(Payment, payment.payment_id) is not None
        or db.scalar(select(Payment.id).where(Payment.number == payment.number)) is not None
    ):
        raise ApiError(
            409, "DUPLICATE_NUMBER", "Payment number already used", {"number": payment.number}
        )

    # Lock the variants in a fixed order so two requests can never wait on each other.
    variants: dict[uuid.UUID, ProductVariant] = {}
    for variant_id in sorted({line.variant_id for line in body.lines}, key=str):
        variants[variant_id] = stock.lock_variant(db, variant_id)
    for variant in variants.values():
        if not variant.is_active:
            raise ApiError(
                409,
                "VARIANT_INACTIVE",
                "A variant on this invoice is stopped",
                {"variant_id": str(variant.id)},
            )

    line_totals = [billing.line_total(line.qty, line.unit_price) for line in body.lines]
    try:
        subtotal, total = billing.invoice_totals(line_totals, body.discount)
        shares = billing.allocate_discount(line_totals, body.discount)
    except ValueError:
        raise ApiError(
            422,
            "DISCOUNT_TOO_LARGE",
            "The discount is larger than the invoice",
            {"subtotal": sum(line_totals)},
        ) from None

    now = clock.utcnow()
    invoice = Invoice(
        id=body.invoice_id,
        number=body.number,
        customer_id=customer.id,
        status="confirmed",
        subtotal=subtotal,
        discount=body.discount,
        total=total,
        note=body.note,
        issued_at=body.issued_at,
        device_id=device.id,
        created_at=now,
        updated_at=now,
        change_seq=seq,
    )
    db.add(invoice)
    db.flush()  # the lines and movements below point at it

    warnings: list[dict[str, Any]] = []
    for order, (line, line_total, share) in enumerate(
        zip(body.lines, line_totals, shares, strict=True)
    ):
        variant = variants[line.variant_id]
        product = db.get(Product, variant.product_id)
        if variant.price != line.unit_price:
            warnings.append(
                {
                    "code": "PRICE_CHANGED",
                    "variant_id": str(variant.id),
                    "current": variant.price,
                    "sold": line.unit_price,
                }
            )
        db.add(
            InvoiceLine(
                id=line.line_id,
                invoice_id=invoice.id,
                variant_id=variant.id,
                product_name=product.name if product else "",
                variant_label=_label(variant),
                qty=line.qty,
                unit_price=line.unit_price,
                line_total=line_total,
                discount_share=share,
                sort_order=order,
                change_seq=seq,
            )
        )
        stock.apply_movement(
            db,
            movement_id=_movement_id("sale", line.line_id),
            variant_id=variant.id,
            qty=line.qty,
            type="sale",
            seq=seq,
            device_id=device.id,
            ref_type="invoice",
            ref_id=invoice.id,
            allow_negative=True,  # the sale really happened: record it, then warn
        )
    for variant in variants.values():
        if variant.stock_qty < 0:
            warnings.append(
                {
                    "code": "STOCK_NEGATIVE",
                    "variant_id": str(variant.id),
                    "stock_qty": variant.stock_qty,
                }
            )

    paid = 0
    if payment is not None:
        paid = payment.amount
        db.add(
            Payment(
                id=payment.payment_id,
                number=payment.number,
                customer_id=customer.id,
                invoice_id=invoice.id,
                method=payment.method,
                amount=payment.amount,
                paid_at=body.issued_at,
                note=payment.note,
                status="active",
                device_id=device.id,
                created_at=now,
                updated_at=now,
                change_seq=seq,
            )
        )
    customers.touch(customer, seq)
    audit(
        db,
        "invoice",
        invoice.id,
        "create",
        after={"number": invoice.number, "total": total, "paid": paid},
        device_id=device.id,
    )
    db.flush()
    return (
        {
            "invoice_id": str(invoice.id),
            "number": invoice.number,
            "subtotal": subtotal,
            "discount": body.discount,
            "total": total,
            "paid": paid,
            "remaining": billing.remaining_on_invoice(total, paid),
            "customer_id": str(customer.id),
            "customer_balance": customers.balance_of(db, customer.id),
            "variants": stock.variant_states(db, list(variants)),
        },
        warnings,
    )


def mark_delivered(
    db: Session, device: Device, body: MarkDeliveredPayload, seq: int
) -> dict[str, Any]:
    invoice = _lock_invoice(db, body.invoice_id)
    if invoice.status == "cancelled":
        raise ApiError(409, "INVOICE_CANCELLED", "A cancelled invoice can't be delivered")
    if invoice.delivered_at is None:  # a repeat keeps the first time
        invoice.delivered_at = body.delivered_at
        invoice.updated_at = clock.utcnow()
        invoice.change_seq = seq
        audit(
            db,
            "invoice",
            invoice.id,
            "deliver",
            after={"delivered_at": body.delivered_at.isoformat()},
            device_id=device.id,
        )
    db.flush()
    return {"invoice_id": str(invoice.id)}


def has_returns(db: Session, invoice_id: uuid.UUID) -> bool:
    """Returns arrive with M7; until then no invoice has any."""
    return False


def cancel_invoice(
    db: Session, device: Device, body: CancelPayload, seq: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    invoice = _lock_invoice(db, body.invoice_id)
    warnings: list[dict[str, Any]] = []
    if invoice.status == "cancelled":  # a repeat: nothing more to do
        warnings.append({"code": "ALREADY_CANCELLED"})
        return {
            "invoice_id": str(invoice.id),
            "variants": [],
            "customer_balance": customers.balance_of(db, invoice.customer_id),
        }, warnings
    if has_returns(db, invoice.id):
        raise ApiError(409, "HAS_RETURNS", "An invoice with returns can't be cancelled")

    lines = db.scalars(
        select(InvoiceLine)
        .where(InvoiceLine.invoice_id == invoice.id)
        .order_by(InvoiceLine.sort_order)
    ).all()
    for variant_id in sorted({line.variant_id for line in lines}, key=str):
        stock.lock_variant(db, variant_id)
    for line in lines:
        stock.apply_movement(
            db,
            movement_id=_movement_id("sale_cancel", line.id),
            variant_id=line.variant_id,
            qty=line.qty,
            type="sale_cancel",
            seq=seq,
            note=body.reason,
            device_id=device.id,
            ref_type="invoice",
            ref_id=invoice.id,
        )
    now = clock.utcnow()
    invoice.status = "cancelled"
    invoice.cancelled_at = body.cancelled_at
    invoice.cancel_reason = body.reason
    invoice.updated_at = now
    invoice.change_seq = seq
    voided = 0
    if body.void_payment:
        for payment in db.scalars(
            select(Payment).where(Payment.invoice_id == invoice.id, Payment.status == "active")
        ):
            payment.status = "voided"
            payment.voided_at = body.cancelled_at
            payment.void_reason = body.reason
            payment.updated_at = now
            payment.change_seq = seq
            voided += 1
    customer = _get_customer(db, invoice.customer_id)
    customers.touch(customer, seq)
    audit(
        db,
        "invoice",
        invoice.id,
        "cancel",
        after={"reason": body.reason, "void_payment": body.void_payment, "voided_payments": voided},
        device_id=device.id,
    )
    db.flush()
    return (
        {
            "invoice_id": str(invoice.id),
            "customer_id": str(customer.id),
            "customer_balance": customers.balance_of(db, customer.id),
            "variants": stock.variant_states(db, [line.variant_id for line in lines]),
        },
        warnings,
    )


def _lock_invoice(db: Session, invoice_id: uuid.UUID) -> Invoice:
    invoice = db.execute(
        select(Invoice)
        .where(Invoice.id == invoice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if invoice is None:
        raise ApiError(
            409, "INVOICE_NOT_FOUND", "Invoice not found", {"invoice_id": str(invoice_id)}
        )
    return invoice

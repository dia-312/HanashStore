"""Standalone payments and voiding (SPEC sections 4 F10 and 7).

A payment is written once and never edited: only its status changes, to voided, with a reason.
Everything here runs inside the caller's transaction (one command = one transaction).
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.models import Customer, Device, Payment
from app.schemas import PaymentCreatePayload, PaymentVoidPayload
from app.services import customers


def _customer(db: Session, customer_id: uuid.UUID) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise ApiError(
            409, "CUSTOMER_NOT_FOUND", "Customer not found", {"customer_id": str(customer_id)}
        )
    return customer


def create_payment(
    db: Session, device: Device, body: PaymentCreatePayload, seq: int
) -> dict[str, Any]:
    # A stopped customer may still pay what he owes: only a missing one is refused.
    customer = _customer(db, body.customer_id)
    if (
        db.get(Payment, body.payment_id) is not None
        or db.scalar(select(Payment.id).where(Payment.number == body.number)) is not None
    ):
        raise ApiError(
            409, "DUPLICATE_NUMBER", "Payment number already used", {"number": body.number}
        )
    now = clock.utcnow()
    db.add(
        Payment(
            id=body.payment_id,
            number=body.number,
            customer_id=customer.id,
            invoice_id=None,
            method=body.method,
            amount=body.amount,
            paid_at=body.paid_at,
            note=body.note or None,
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
        "payment",
        body.payment_id,
        "create",
        after={"number": body.number, "amount": body.amount, "method": body.method},
        device_id=device.id,
    )
    db.flush()
    return {
        "payment_id": str(body.payment_id),
        "number": body.number,
        "customer_id": str(customer.id),
        "customer_balance": customers.balance_of(db, customer.id),
    }


def void_payment(
    db: Session, device: Device, body: PaymentVoidPayload, seq: int
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payment = db.execute(
        select(Payment)
        .where(Payment.id == body.payment_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if payment is None:
        raise ApiError(
            409, "PAYMENT_NOT_FOUND", "Payment not found", {"payment_id": str(body.payment_id)}
        )
    customer = _customer(db, payment.customer_id)
    warnings: list[dict[str, Any]] = []
    if payment.status == "voided":  # a repeat (or already voided by a cancellation): nothing to do
        warnings.append({"code": "ALREADY_VOIDED"})
    else:
        payment.status = "voided"
        payment.voided_at = body.voided_at
        payment.void_reason = body.reason
        payment.updated_at = clock.utcnow()
        payment.change_seq = seq
        customers.touch(customer, seq)
        audit(
            db,
            "payment",
            payment.id,
            "void",
            after={"reason": body.reason, "amount": payment.amount},
            device_id=device.id,
        )
    db.flush()
    return (
        {
            "payment_id": str(payment.id),
            "customer_id": str(customer.id),
            "customer_balance": customers.balance_of(db, customer.id),
        },
        warnings,
    )

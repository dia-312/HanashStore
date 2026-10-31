"""Customers: the profile data and the balance (SPEC sections 4 F4 and 7)."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.models import Customer, Invoice, Payment
from app.normalize import normalize_arabic
from app.services import billing


def search_text(customer: Customer) -> str:
    """What the customer search matches: name, shop, phone and area (SPEC F4), normalized."""
    parts = [customer.name, customer.shop_name or "", customer.phone or "", customer.area or ""]
    return normalize_arabic(" ".join(parts))


def balance_of(db: Session, customer_id: uuid.UUID) -> int:
    """opening + confirmed invoices - returns - active payments. Returns arrive in M7."""
    opening = db.scalar(select(Customer.opening_balance).where(Customer.id == customer_id)) or 0
    return _balances(db, [customer_id]).get(customer_id, opening)


def _balances(db: Session, customer_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Balances of several customers with three aggregate queries, not one query per customer."""
    if not customer_ids:
        return {}
    invoices = {
        row[0]: row[1]
        for row in db.execute(
            select(Invoice.customer_id, func.sum(Invoice.total))
            .where(Invoice.customer_id.in_(customer_ids), Invoice.status == "confirmed")
            .group_by(Invoice.customer_id)
        )
    }
    payments = {
        row[0]: row[1]
        for row in db.execute(
            select(Payment.customer_id, func.sum(Payment.amount))
            .where(Payment.customer_id.in_(customer_ids), Payment.status == "active")
            .group_by(Payment.customer_id)
        )
    }
    openings = {
        row[0]: row[1]
        for row in db.execute(
            select(Customer.id, Customer.opening_balance).where(Customer.id.in_(customer_ids))
        )
    }
    return {
        cid: billing.customer_balance(
            openings.get(cid, 0), int(invoices.get(cid, 0)), 0, int(payments.get(cid, 0))
        )
        for cid in customer_ids
    }


def balances(db: Session, customer_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    return _balances(db, customer_ids)


def touch(customer: Customer, seq: int) -> None:
    """A change that moves the balance also moves the row, so devices pull the new balance."""
    customer.updated_at = clock.utcnow()
    customer.change_seq = seq


def upsert(
    db: Session,
    *,
    customer_id: uuid.UUID,
    name: str,
    shop_name: str | None,
    phone: str | None,
    area: str | None,
    address: str | None,
    notes: str | None,
    opening_balance: int,
    is_active: bool,
    seq: int,
    device_id: uuid.UUID,
) -> Customer:
    """Create the customer, or edit him. The opening balance is only taken on creation: after
    that the balance moves through invoices and payments, never by editing."""
    now = clock.utcnow()
    existing = db.get(Customer, customer_id)
    if existing is None:
        customer = Customer(
            id=customer_id,
            name=name,
            shop_name=shop_name,
            phone=phone,
            area=area,
            address=address,
            notes=notes,
            opening_balance=opening_balance,
            search_text="",
            is_active=is_active,
            created_at=now,
            updated_at=now,
            change_seq=seq,
        )
        customer.search_text = search_text(customer)
        db.add(customer)
        audit(db, "customer", customer_id, "create", after={"name": name}, device_id=device_id)
    else:
        before = {"name": existing.name, "is_active": existing.is_active}
        existing.name = name
        existing.shop_name = shop_name
        existing.phone = phone
        existing.area = area
        existing.address = address
        existing.notes = notes
        existing.is_active = is_active
        existing.search_text = search_text(existing)
        touch(existing, seq)
        customer = existing
        audit(
            db,
            "customer",
            customer_id,
            "update",
            before=before,
            after={"name": name, "is_active": is_active},
            device_id=device_id,
        )
    db.flush()
    return customer

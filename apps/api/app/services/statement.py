"""Customer statement (كشف حساب, SPEC section 7). Flagged for line-by-line review: money.

Rows are the opening balance, invoices (debit) and payments (credit) in chronological order, with a
running balance. Returns (credit) arrive with M7. A cancelled invoice and a voided payment are
shown only on request and never move the balance."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import Customer, Invoice, Payment

HEBRON = ZoneInfo("Asia/Hebron")
DEFAULT_MONTHS = 3


@dataclass
class StatementRow:
    kind: str  # opening | invoice | payment
    moment: datetime
    ref: str
    debit: int
    credit: int
    off: str | None  # "cancelled" or "voided": shown, but not counted
    balance: int = 0


@dataclass
class Statement:
    rows: list[StatementRow] = field(default_factory=list)
    total_debit: int = 0
    total_credit: int = 0
    closing: int = 0


def default_period(today: date) -> tuple[date, date]:
    """The last three months, ending today."""
    month = today.month - DEFAULT_MONTHS
    year = today.year
    if month < 1:
        month += 12
        year -= 1
    return date(year, month, min(today.day, 28)), today


def _start(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=HEBRON).astimezone(UTC)


def _end(d: date) -> datetime:
    return _start(d + timedelta(days=1))


def build(
    db: Session,
    customer_id: uuid.UUID,
    date_from: date,
    date_to: date,
    include_off: bool = False,
) -> Statement:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise ApiError(404, "NOT_FOUND", "Customer not found")
    start, end = _start(date_from), _end(date_to)

    # What he owed when the period began: the opening balance plus everything before it.
    before_invoices = (
        db.scalar(
            select(func.coalesce(func.sum(Invoice.total), 0)).where(
                Invoice.customer_id == customer_id,
                Invoice.status == "confirmed",
                Invoice.issued_at < start,
            )
        )
        or 0
    )
    before_payments = (
        db.scalar(
            select(func.coalesce(func.sum(Payment.amount), 0)).where(
                Payment.customer_id == customer_id,
                Payment.status == "active",
                Payment.paid_at < start,
            )
        )
        or 0
    )
    balance = int(customer.opening_balance + before_invoices - before_payments)

    rows = [StatementRow("opening", start, "", 0, 0, None, balance)]
    entries: list[StatementRow] = []
    for inv in db.scalars(
        select(Invoice).where(
            Invoice.customer_id == customer_id, Invoice.issued_at >= start, Invoice.issued_at < end
        )
    ):
        off = None if inv.status == "confirmed" else "cancelled"
        if off is None or include_off:
            entries.append(StatementRow("invoice", inv.issued_at, inv.number, inv.total, 0, off))
    for pay in db.scalars(
        select(Payment).where(
            Payment.customer_id == customer_id, Payment.paid_at >= start, Payment.paid_at < end
        )
    ):
        off = None if pay.status == "active" else "voided"
        if off is None or include_off:
            entries.append(StatementRow("payment", pay.paid_at, pay.number, 0, pay.amount, off))
    # An invoice comes before the payment taken with it (same moment).
    entries.sort(key=lambda r: (r.moment, 0 if r.kind == "invoice" else 1, r.ref))

    result = Statement()
    for row in entries:
        if row.off is None:
            balance += row.debit - row.credit
            result.total_debit += row.debit
            result.total_credit += row.credit
        row.balance = balance
        rows.append(row)
    result.rows = rows
    result.closing = balance
    return result

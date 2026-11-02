"""Reports (SPEC F12), computed on the server from the books. Money is integer agorot; days are
Asia/Hebron calendar days, both ends included. Flagged for line-by-line review: money.

The one definition of "sales" used everywhere: the totals of confirmed invoices issued in the
period, minus the credit of returns issued in the period. A cancelled invoice never counts. Sales by
product use the same lines (`line_total - discount_share`, minus the credit of returned lines), so
the products add up to the sales total exactly.
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from sqlalchemy import Date, case, cast, func, select
from sqlalchemy.orm import Session

from app import clock
from app.errors import ApiError
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
MIN_DATE, MAX_DATE = date(2000, 1, 1), date(2100, 12, 31)
MAX_DAYS = 731  # two years of daily rows is plenty for a chart


def today() -> date:
    return clock.utcnow().astimezone(HEBRON).date()


def _start(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=HEBRON).astimezone(UTC)


def _bounds(date_from: date, date_to: date) -> tuple[datetime, datetime]:
    return _start(date_from), _start(date_to + timedelta(days=1))


def check_period(date_from: date, date_to: date, *, max_days: int = MAX_DAYS) -> None:
    if date_from < MIN_DATE or date_to > MAX_DATE:
        raise ApiError(422, "VALIDATION_ERROR", "The period must be between 2000 and 2100")
    if date_from > date_to:
        raise ApiError(422, "VALIDATION_ERROR", "The period starts after it ends")
    if (date_to - date_from).days + 1 > max_days:
        raise ApiError(422, "VALIDATION_ERROR", f"The period is longer than {max_days} days")


def _local_day(column: Any) -> Any:
    """The Hebron calendar day of a timestamp column."""
    return cast(func.timezone("Asia/Hebron", column), Date)


def _days(date_from: date, date_to: date) -> list[date]:
    return [date_from + timedelta(days=i) for i in range((date_to - date_from).days + 1)]


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _months(date_from: date, date_to: date) -> list[date]:
    out, cursor = [], _month_start(date_from)
    while cursor <= date_to:
        out.append(cursor)
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


# ---------------------------------------------------------------------------------------- sales


@dataclass
class SalesRow:
    period: str  # yyyy-MM-dd for a day, yyyy-MM for a month
    invoices: int = 0
    gross: int = 0
    returns: int = 0

    @property
    def net(self) -> int:
        return self.gross - self.returns


@dataclass
class SalesReport:
    group: str
    date_from: date
    date_to: date
    rows: list[SalesRow] = field(default_factory=list)
    invoices: int = 0
    gross: int = 0
    returns: int = 0

    @property
    def net(self) -> int:
        return self.gross - self.returns


def sales(
    db: Session, date_from: date, date_to: date, group: Literal["day", "month"]
) -> SalesReport:
    check_period(date_from, date_to)
    start, end = _bounds(date_from, date_to)

    def key(d: date) -> str:
        return d.isoformat() if group == "day" else d.strftime("%Y-%m")

    periods = _days(date_from, date_to) if group == "day" else _months(date_from, date_to)
    rows = {key(d): SalesRow(period=key(d)) for d in periods}

    invoice_day = _local_day(Invoice.issued_at)
    for day, count, total in db.execute(
        select(invoice_day, func.count(), func.coalesce(func.sum(Invoice.total), 0))
        .where(Invoice.status == "confirmed", Invoice.issued_at >= start, Invoice.issued_at < end)
        .group_by(invoice_day)
    ):
        row = rows[key(day)]
        row.invoices += int(count)
        row.gross += int(total)
    return_day = _local_day(Return.issued_at)
    for day, total in db.execute(
        select(return_day, func.coalesce(func.sum(Return.total), 0))
        .where(Return.issued_at >= start, Return.issued_at < end)
        .group_by(return_day)
    ):
        rows[key(day)].returns += int(total)

    report = SalesReport(
        group=group, date_from=date_from, date_to=date_to, rows=list(rows.values())
    )
    report.invoices = sum(r.invoices for r in report.rows)
    report.gross = sum(r.gross for r in report.rows)
    report.returns = sum(r.returns for r in report.rows)
    return report


# ------------------------------------------------------------------------------------ products


@dataclass
class ProductRow:
    id: str
    name: str
    detail: str
    qty: int
    amount: int


@dataclass
class ProductsReport:
    by: str
    order: str
    date_from: date
    date_to: date
    rows: list[ProductRow] = field(default_factory=list)
    qty: int = 0
    amount: int = 0


def products(
    db: Session,
    date_from: date,
    date_to: date,
    by: Literal["product", "variant", "category"],
    order: Literal["top", "slow"],
    limit: int,
) -> ProductsReport:
    check_period(date_from, date_to)
    start, end = _bounds(date_from, date_to)

    sold = (
        select(
            InvoiceLine.variant_id.label("variant_id"),
            func.sum(InvoiceLine.qty).label("qty"),
            func.sum(InvoiceLine.line_total - InvoiceLine.discount_share).label("amount"),
        )
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .where(Invoice.status == "confirmed", Invoice.issued_at >= start, Invoice.issued_at < end)
        .group_by(InvoiceLine.variant_id)
    )
    given_back = (
        select(
            InvoiceLine.variant_id.label("variant_id"),
            func.sum(ReturnLine.qty).label("qty"),
            func.sum(ReturnLine.amount).label("amount"),
        )
        .join(InvoiceLine, InvoiceLine.id == ReturnLine.invoice_line_id)
        .join(Return, Return.id == ReturnLine.return_id)
        .where(Return.issued_at >= start, Return.issued_at < end)
        .group_by(InvoiceLine.variant_id)
    )
    sold_by, back_by = sold.subquery(), given_back.subquery()

    # One row per variant that is still on sale, or that sold or came back in the period.
    base = (
        select(
            ProductVariant.id,
            ProductVariant.color,
            ProductVariant.size,
            Product.id.label("product_id"),
            Product.name.label("product_name"),
            Category.id.label("category_id"),
            Category.name.label("category_name"),
            (func.coalesce(sold_by.c.qty, 0) - func.coalesce(back_by.c.qty, 0)).label("qty"),
            (func.coalesce(sold_by.c.amount, 0) - func.coalesce(back_by.c.amount, 0)).label(
                "amount"
            ),
            case(
                (ProductVariant.is_active.is_(True) & Product.is_active.is_(True), 1), else_=0
            ).label("on_sale"),
        )
        .join(Product, Product.id == ProductVariant.product_id)
        .join(Category, Category.id == Product.category_id)
        .outerjoin(sold_by, sold_by.c.variant_id == ProductVariant.id)
        .outerjoin(back_by, back_by.c.variant_id == ProductVariant.id)
    )
    grouped: dict[str, ProductRow] = {}
    on_sale: dict[str, bool] = {}
    for row in db.execute(base):
        if by == "variant":
            ident = str(row.id)
            name = row.product_name
            detail = " · ".join(x for x in (row.color, row.size) if x)
        elif by == "product":
            ident, name, detail = str(row.product_id), row.product_name, row.category_name
        else:
            ident, name, detail = str(row.category_id), row.category_name, ""
        entry = grouped.setdefault(ident, ProductRow(ident, name, detail, 0, 0))
        entry.qty += int(row.qty)
        entry.amount += int(row.amount)
        on_sale[ident] = on_sale.get(ident, False) or bool(row.on_sale)

    if order == "top":
        pool = [r for r in grouped.values() if r.qty > 0 or r.amount > 0]
        pool.sort(key=lambda r: (-r.amount, -r.qty, r.name, r.id))
    else:
        # Slowest first among what is still for sale, the ones that sold nothing leading.
        pool = [r for r in grouped.values() if on_sale[r.id]]
        pool.sort(key=lambda r: (r.amount, r.qty, r.name, r.id))
    report = ProductsReport(by=by, order=order, date_from=date_from, date_to=date_to)
    report.rows = pool[:limit]
    report.qty = sum(r.qty for r in grouped.values())
    report.amount = sum(r.amount for r in grouped.values())
    return report


# ---------------------------------------------------------------------------------- collections


@dataclass
class MoneyRow:
    key: str  # a method, or a day
    received: int = 0
    refunded: int = 0

    @property
    def net(self) -> int:
        return self.received - self.refunded


@dataclass
class CollectionsReport:
    date_from: date
    date_to: date
    by_method: list[MoneyRow] = field(default_factory=list)
    by_day: list[MoneyRow] = field(default_factory=list)
    received: int = 0
    refunded: int = 0

    @property
    def net(self) -> int:
        return self.received - self.refunded


METHODS = ("cash", "transfer", "cheque")


def collections(db: Session, date_from: date, date_to: date) -> CollectionsReport:
    check_period(date_from, date_to)
    start, end = _bounds(date_from, date_to)
    by_method = {m: MoneyRow(m) for m in METHODS}
    by_day = {d.isoformat(): MoneyRow(d.isoformat()) for d in _days(date_from, date_to)}
    day = _local_day(Payment.paid_at)
    for kind, method, d, total in db.execute(
        select(Payment.kind, Payment.method, day, func.coalesce(func.sum(Payment.amount), 0))
        .where(Payment.status == "active", Payment.paid_at >= start, Payment.paid_at < end)
        .group_by(Payment.kind, Payment.method, day)
    ):
        for row in (by_method.setdefault(method, MoneyRow(method)), by_day[d.isoformat()]):
            if kind == "refund":
                row.refunded += int(total)
            else:
                row.received += int(total)
    report = CollectionsReport(
        date_from=date_from,
        date_to=date_to,
        by_method=list(by_method.values()),
        by_day=list(by_day.values()),
    )
    report.received = sum(r.received for r in report.by_method)
    report.refunded = sum(r.refunded for r in report.by_method)
    return report


# ------------------------------------------------------------------------------------ balances


@dataclass
class BalanceRow:
    id: str
    name: str
    shop_name: str | None
    phone: str | None
    balance: int
    last_payment_at: datetime | None
    days_since_payment: int | None


@dataclass
class BalancesReport:
    rows: list[BalanceRow] = field(default_factory=list)
    total_owed: int = 0
    total_credit: int = 0
    owing: int = 0


def balances(db: Session) -> BalancesReport:
    rows_ = list(db.scalars(select(Customer)))
    balance_of = customers.balances(db, [c.id for c in rows_])
    last_paid = {
        row[0]: row[1]
        for row in db.execute(
            select(Payment.customer_id, func.max(Payment.paid_at))
            .where(Payment.status == "active", Payment.kind == "payment")
            .group_by(Payment.customer_id)
        )
    }
    now = today()
    out = []
    for c in rows_:
        balance = balance_of.get(c.id, c.opening_balance)
        if balance == 0:
            continue
        paid = last_paid.get(c.id)
        days = (now - paid.astimezone(HEBRON).date()).days if paid else None
        out.append(BalanceRow(str(c.id), c.name, c.shop_name, c.phone, balance, paid, days))
    out.sort(key=lambda r: (-r.balance, r.name, r.id))
    report = BalancesReport(rows=out)
    report.total_owed = sum(r.balance for r in out if r.balance > 0)
    report.total_credit = -sum(r.balance for r in out if r.balance < 0)
    report.owing = sum(1 for r in out if r.balance > 0)
    return report


# --------------------------------------------------------------------------------------- stock


@dataclass
class StockRow:
    variant_id: str
    product_id: str
    name: str
    color: str | None
    size: str | None
    sku: str
    qty: int
    min_stock: int


@dataclass
class StockReport:
    low: list[StockRow] = field(default_factory=list)
    out: list[StockRow] = field(default_factory=list)
    negative: list[StockRow] = field(default_factory=list)


def stock(db: Session) -> StockReport:
    report = StockReport()
    query = (
        select(ProductVariant, Product.name)
        .join(Product, Product.id == ProductVariant.product_id)
        .where(ProductVariant.is_active.is_(True), Product.is_active.is_(True))
        .order_by(Product.name, ProductVariant.sku)
    )
    for variant, name in db.execute(query):
        row = StockRow(
            str(variant.id),
            str(variant.product_id),
            name,
            variant.color,
            variant.size,
            variant.sku,
            variant.stock_qty,
            variant.min_stock,
        )
        if variant.stock_qty < 0:
            report.negative.append(row)
        elif variant.stock_qty == 0:
            report.out.append(row)
        elif variant.stock_qty <= variant.min_stock:
            report.low.append(row)
    return report


# ----------------------------------------------------------------------------------- damaged


@dataclass
class DamagedRow:
    at: datetime
    source: str  # write_off (stock.damage) | return (a returned item that was not put back)
    variant_id: str
    name: str
    color: str | None
    size: str | None
    qty: int
    ref: str | None
    note: str | None


@dataclass
class DamagedReport:
    date_from: date
    date_to: date
    rows: list[DamagedRow] = field(default_factory=list)
    write_off_qty: int = 0
    return_qty: int = 0


def damaged(db: Session, date_from: date, date_to: date) -> DamagedReport:
    check_period(date_from, date_to)
    start, end = _bounds(date_from, date_to)
    report = DamagedReport(date_from=date_from, date_to=date_to)
    for movement, name, color, size in db.execute(
        select(StockMovement, Product.name, ProductVariant.color, ProductVariant.size)
        .join(ProductVariant, ProductVariant.id == StockMovement.variant_id)
        .join(Product, Product.id == ProductVariant.product_id)
        .where(
            StockMovement.type == "damage",
            StockMovement.created_at >= start,
            StockMovement.created_at < end,
        )
    ):
        report.rows.append(
            DamagedRow(
                movement.created_at,
                "write_off",
                str(movement.variant_id),
                name,
                color,
                size,
                -movement.qty,
                None,
                movement.note,
            )
        )
    for line, ret, variant, name in db.execute(
        select(ReturnLine, Return, ProductVariant, Product.name)
        .join(Return, Return.id == ReturnLine.return_id)
        .join(InvoiceLine, InvoiceLine.id == ReturnLine.invoice_line_id)
        .join(ProductVariant, ProductVariant.id == InvoiceLine.variant_id)
        .join(Product, Product.id == ProductVariant.product_id)
        .where(
            ReturnLine.disposition == "damaged", Return.issued_at >= start, Return.issued_at < end
        )
    ):
        report.rows.append(
            DamagedRow(
                ret.issued_at,
                "return",
                str(variant.id),
                name,
                variant.color,
                variant.size,
                line.qty,
                ret.number,
                ret.reason,
            )
        )
    report.rows.sort(key=lambda r: (r.at, r.ref or "", r.variant_id), reverse=True)
    report.write_off_qty = sum(r.qty for r in report.rows if r.source == "write_off")
    report.return_qty = sum(r.qty for r in report.rows if r.source == "return")
    return report

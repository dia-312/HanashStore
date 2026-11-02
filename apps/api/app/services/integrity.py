"""Are the books consistent? (`python -m app.cli check-books`)

Run after a restore, and by the restore drill on a copy of the last backup, to prove that a backup
is not just a file but a working set of books. Every rule is written again here from the rows, not
borrowed from the code that writes them: that is the point of checking.
"""

from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.stock import stock_mismatches


@dataclass
class Report:
    problems: list[str] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.problems


# One query per rule; each returns the offending rows (empty = the rule holds).
RULES: dict[str, str] = {
    "invoice lines do not add up to the invoice subtotal": """
        SELECT i.number FROM invoices i
        WHERE i.subtotal <> COALESCE((SELECT SUM(l.line_total) FROM invoice_lines l
                                      WHERE l.invoice_id = i.id), 0)""",
    "invoice total is not subtotal minus discount": """
        SELECT number FROM invoices WHERE total <> subtotal - discount""",
    "invoice discount outside 0..subtotal": """
        SELECT number FROM invoices WHERE discount < 0 OR discount > subtotal""",
    "discount shares do not add up to the discount": """
        SELECT i.number FROM invoices i
        WHERE i.discount <> COALESCE((SELECT SUM(l.discount_share) FROM invoice_lines l
                                      WHERE l.invoice_id = i.id), 0)""",
    "invoice line total is not qty x unit price": """
        SELECT i.number FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE l.line_total <> l.qty * l.unit_price""",
    "an invoice without lines": """
        SELECT i.number FROM invoices i
        WHERE NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id)""",
    "return total is not the sum of its lines": """
        SELECT r.number FROM returns r
        WHERE r.total <> COALESCE((SELECT SUM(x.amount) FROM return_lines x
                                   WHERE x.return_id = r.id), 0)""",
    "a line returned more than it sold": """
        SELECT i.number FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        WHERE COALESCE((SELECT SUM(x.qty) FROM return_lines x
                        WHERE x.invoice_line_id = l.id), 0) > l.qty""",
    "a line credited more than it was worth, or less when all of it came back": """
        SELECT i.number FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
        CROSS JOIN LATERAL (SELECT COALESCE(SUM(x.qty), 0) AS q, COALESCE(SUM(x.amount), 0) AS a
                            FROM return_lines x WHERE x.invoice_line_id = l.id) back
        WHERE back.a > l.line_total - l.discount_share
           OR (back.q = l.qty AND back.a <> l.line_total - l.discount_share)""",
    "a payment or refund of zero or less": """
        SELECT number FROM payments WHERE amount <= 0""",
    "a voided payment without a void time": """
        SELECT number FROM payments WHERE status = 'voided' AND voided_at IS NULL""",
    "a number used twice": """
        SELECT number FROM (
            SELECT number FROM invoices UNION ALL SELECT number FROM payments
            UNION ALL SELECT number FROM returns) n
        GROUP BY number HAVING COUNT(*) > 1""",
    "sync clock behind the rows it numbered": """
        SELECT 'last_seq' FROM sync_clock c
        WHERE c.last_seq < GREATEST(
            (SELECT COALESCE(MAX(change_seq), 0) FROM invoices),
            (SELECT COALESCE(MAX(change_seq), 0) FROM payments),
            (SELECT COALESCE(MAX(change_seq), 0) FROM returns),
            (SELECT COALESCE(MAX(change_seq), 0) FROM customers),
            (SELECT COALESCE(MAX(change_seq), 0) FROM product_variants),
            (SELECT COALESCE(MAX(change_seq), 0) FROM products))""",
}

# A customer's balance written once more, in SQL, to be compared with the one the app reports.
BALANCE_SQL = """
    SELECT c.id, c.name,
           c.opening_balance
           + COALESCE((SELECT SUM(total) FROM invoices
                       WHERE customer_id = c.id AND status = 'confirmed'), 0)
           - COALESCE((SELECT SUM(total) FROM returns WHERE customer_id = c.id), 0)
           - COALESCE((SELECT SUM(amount) FROM payments
                       WHERE customer_id = c.id AND status = 'active' AND kind = 'payment'), 0)
           + COALESCE((SELECT SUM(amount) FROM payments
                       WHERE customer_id = c.id AND status = 'active' AND kind = 'refund'), 0)
           AS balance
    FROM customers c"""

COUNTED = (
    "customers",
    "categories",
    "products",
    "product_variants",
    "invoices",
    "invoice_lines",
    "payments",
    "returns",
    "return_lines",
    "stock_movements",
)


def check(db: Session) -> Report:
    from app.services import customers  # local: avoids a cycle at import time

    report = Report()
    for table in COUNTED:
        report.counts[table] = int(db.scalar(text(f"SELECT COUNT(*) FROM {table}")) or 0)  # noqa: S608

    for name, query in RULES.items():
        bad = [str(r[0]) for r in db.execute(text(query))]
        if bad:
            report.problems.append(
                f"{name}: {', '.join(bad[:5])}" + (" ..." if len(bad) > 5 else "")
            )

    for variant_id, cached, actual in stock_mismatches(db):
        report.problems.append(f"stock cache of {variant_id} is {cached}, movements say {actual}")

    written = {row[0]: (row[1], int(row[2])) for row in db.execute(text(BALANCE_SQL))}
    reported = customers.balances(db, list(written))
    for customer_id, (name, balance) in written.items():
        if reported.get(customer_id, balance) != balance:
            report.problems.append(
                f"balance of {name}: the app says {reported[customer_id]}, the rows say {balance}"
            )
    return report

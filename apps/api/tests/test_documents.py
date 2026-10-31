import json
import re
import uuid
from datetime import date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Customer, Invoice, InvoiceLine, Payment
from app.services import documents, pdf, statement
from app.services.documents import SHARED_DIR, money, stamp
from tests import helpers
from tests.conftest import new_client

V1 = "/api/v1"
SHARED = SHARED_DIR
CASES: dict[str, Any] = json.loads((SHARED / "documents_cases.json").read_text("utf-8"))


def _when(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def _load(api: TestClient, db: Session) -> uuid.UUID:
    """Puts the shared scenario in the database: settings, the customer, invoices and payments."""
    assert (
        api.patch(V1 + "/settings", json=CASES["settings"] | {"logo_url": None}).status_code == 200
    )
    product = helpers.product(api)
    variant_id = uuid.UUID(helpers.variant(api, product["id"], 100)["id"])
    device_id = uuid.UUID(helpers.device_id(api))
    c = CASES["customer"]
    customer_id = uuid.UUID(c["id"])
    now = _when("2026-01-01T00:00:00Z")
    db.add(
        Customer(
            id=customer_id,
            name=c["name"],
            shop_name=c["shop_name"],
            phone=c["phone"],
            opening_balance=c["opening_balance"],
            search_text="x",
            is_active=True,
            created_at=now,
            updated_at=now,
            change_seq=1,
        )
    )
    db.flush()
    for inv in CASES["invoices"]:
        invoice_id = uuid.UUID(inv["id"])
        db.add(
            Invoice(
                id=invoice_id,
                number=inv["number"],
                customer_id=customer_id,
                status=inv["status"],
                subtotal=inv["subtotal"],
                discount=inv["discount"],
                total=inv["total"],
                note=inv["note"],
                issued_at=_when(inv["issued_at"]),
                cancel_reason=inv["cancel_reason"],
                device_id=device_id,
                created_at=now,
                updated_at=now,
                change_seq=1,
            )
        )
        db.flush()
        for order, line in enumerate(inv["lines"]):
            db.add(
                InvoiceLine(
                    id=uuid.uuid4(),
                    invoice_id=invoice_id,
                    variant_id=variant_id,
                    sort_order=order,
                    change_seq=1,
                    **line,
                )
            )
        for pay in inv["payments"]:
            db.add(_payment(pay, customer_id, invoice_id, device_id, now))
    for pay in CASES["standalone_payments"]:
        db.add(_payment(pay, customer_id, None, device_id, now))
    db.commit()
    return customer_id


def _payment(
    pay: dict[str, Any],
    customer_id: uuid.UUID,
    invoice_id: uuid.UUID | None,
    device_id: uuid.UUID,
    now: datetime,
) -> Payment:
    return Payment(
        id=uuid.UUID(pay["id"]),
        number=pay["number"],
        customer_id=customer_id,
        invoice_id=invoice_id,
        method=pay["method"],
        amount=pay["amount"],
        paid_at=_when(pay["paid_at"]),
        status=pay["status"],
        device_id=device_id,
        created_at=now,
        updated_at=now,
        change_seq=1,
    )


def _text(html: str) -> str:
    html = re.sub(r"(?s)<style.*?</style>", "", html)
    html = re.sub(r"(?s)<title>.*?</title>", "", html)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


# --- formatting -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("agorot", "text"),
    [
        (0, "₪ 0.00"),
        (5, "₪ 0.05"),
        (125000, "₪ 1,250.00"),
        (-2000, "-₪ 20.00"),
        (123456789, "₪ 1,234,567.89"),
    ],
)
def test_money_is_exact_with_latin_digits_and_thousands_commas(agorot: int, text: str) -> None:
    assert money(agorot) == text


def test_times_are_shown_in_hebron_winter_and_summer() -> None:
    assert stamp(_when("2026-11-02T09:14:20Z")) == "02/11/2026 11:14"  # UTC+2
    assert stamp(_when("2026-07-10T09:30:00Z")) == "10/07/2026 12:30"  # UTC+3


# --- invoice document -------------------------------------------------------------------------


@pytest.mark.parametrize("number", ["INV-000001", "INV-000002", "INV-000003"])
def test_the_invoice_document_matches_the_shared_expected_model(
    api: TestClient, db: Session, number: str
) -> None:
    _load(api, db)
    invoice = db.query(Invoice).filter(Invoice.number == number).one()
    assert documents.invoice_document(db, invoice.id) == CASES["expected_invoices"][number]


def test_the_invoice_shows_paid_and_remaining_but_no_customer_balance(
    api: TestClient, db: Session
) -> None:
    _load(api, db)
    invoice = db.query(Invoice).filter(Invoice.number == "INV-000001").one()
    doc = documents.invoice_document(db, invoice.id)
    assert doc["totals"]["paid"] == "₪ 30.00" and doc["totals"]["remaining"] == "₪ 70.00"
    html = pdf.render_html("invoice.html", doc, "invoice")
    assert "الرصيد" not in html  # client decision: no overall balance on the invoice


def test_a_cancelled_invoice_carries_the_stamp_and_the_reason(api: TestClient, db: Session) -> None:
    _load(api, db)
    invoice = db.query(Invoice).filter(Invoice.number == "INV-000003").one()
    html = pdf.render_html("invoice.html", documents.invoice_document(db, invoice.id), "invoice")
    assert "ملغاة" in html and "خطأ بالكمية" in html
    other = db.query(Invoice).filter(Invoice.number == "INV-000001").one()
    assert 'class="stamp"' not in pdf.render_html(
        "invoice.html", documents.invoice_document(db, other.id), "invoice"
    )


def test_a_discount_row_only_shows_when_there_is_a_discount(api: TestClient, db: Session) -> None:
    _load(api, db)
    with_discount = db.query(Invoice).filter(Invoice.number == "INV-000001").one()
    without = db.query(Invoice).filter(Invoice.number == "INV-000002").one()
    assert "الخصم" in pdf.render_html(
        "invoice.html", documents.invoice_document(db, with_discount.id), "invoice"
    )
    assert "الخصم" not in pdf.render_html(
        "invoice.html", documents.invoice_document(db, without.id), "invoice"
    )


def test_placeholders_show_until_the_client_gives_his_details(api: TestClient, db: Session) -> None:
    _load(api, db)
    api.patch(
        V1 + "/settings", json={"business_name": "اسم المنشأة", "phone": "", "invoice_footer": ""}
    )
    invoice = db.query(Invoice).filter(Invoice.number == "INV-000002").one()
    html = pdf.render_html("invoice.html", documents.invoice_document(db, invoice.id), "invoice")
    assert "اسم المنشأة" in html and "شكراً لتعاملكم" not in html


# --- statement --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case", CASES["statements"], ids=[c["name"][:30] for c in CASES["statements"]]
)
def test_the_statement_matches_the_shared_expected_rows(
    api: TestClient, db: Session, case: dict[str, Any]
) -> None:
    customer_id = _load(api, db)
    start, end = date.fromisoformat(case["from"]), date.fromisoformat(case["to"])
    data = statement.build(db, customer_id, start, end, case["include_off"])
    customer = db.get(Customer, customer_id)
    assert customer is not None
    assert documents.statement_document(db, customer, data, start, end) == case["expected"]


def test_the_default_period_is_the_last_three_months() -> None:
    assert statement.default_period(date(2026, 11, 15)) == (date(2026, 8, 15), date(2026, 11, 15))
    assert statement.default_period(date(2026, 2, 10)) == (date(2025, 11, 10), date(2026, 2, 10))
    assert statement.default_period(date(2026, 5, 31)) == (date(2026, 2, 28), date(2026, 5, 31))


def test_the_closing_balance_is_the_balance_formula(api: TestClient, db: Session) -> None:
    customer_id = _load(api, db)
    data = statement.build(db, customer_id, date(2026, 1, 1), date(2026, 12, 31))
    # 50 + 100 + 45 - (30 + 45 + 20); the cancelled invoice and the voided payment are ignored
    assert data.closing == 5000 + 10000 + 4500 - (3000 + 4500 + 2000)
    rows_balance = [r.balance for r in data.rows]
    assert rows_balance[-1] == data.closing


def test_the_statement_rows_endpoint_and_defaults(api: TestClient, db: Session) -> None:
    customer_id = _load(api, db)
    r = api.get(
        f"{V1}/customers/{customer_id}/statement", params={"from": "2026-01-01", "to": "2026-12-31"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["closing"] == 10000 and body["rows"][0]["kind"] == "opening"
    assert api.get(f"{V1}/customers/{customer_id}/statement").status_code == 200  # default period
    bad = api.get(
        f"{V1}/customers/{customer_id}/statement", params={"from": "2026-12-31", "to": "2026-01-01"}
    )
    assert bad.status_code == 422
    assert api.get(f"{V1}/customers/{uuid.uuid4()}/statement").status_code == 404


# --- templates, parity text and PDFs ----------------------------------------------------------


def test_the_templates_render_the_text_in_the_shared_expected_file(
    api: TestClient, db: Session
) -> None:
    expected: dict[str, str] = json.loads(
        (SHARED / "documents_expected_text.json").read_text("utf-8")
    )
    invoice = pdf.render_html("invoice.html", CASES["expected_invoices"]["INV-000001"], "invoice")
    assert _text(invoice) == expected["invoice"]
    cancelled = pdf.render_html("invoice.html", CASES["expected_invoices"]["INV-000003"], "invoice")
    assert _text(cancelled) == expected["invoice_cancelled"]
    stmt = pdf.render_html("statement.html", CASES["statements"][1]["expected"], "statement")
    assert _text(stmt) == expected["statement"]


def _can_render_pdf() -> bool:
    try:
        pdf.render_pdf("statement.html", CASES["statements"][0]["expected"], "statement")
    except OSError:  # pango is not installed on this machine (it is in Docker and on CI)
        return False
    return True


needs_pango = pytest.mark.skipif(
    not _can_render_pdf(), reason="WeasyPrint needs pango and harfbuzz"
)


@needs_pango
def test_the_invoice_pdf_is_a_real_one_page_pdf_with_the_invoice_name(
    api: TestClient, db: Session
) -> None:
    _load(api, db)
    invoice = db.query(Invoice).filter(Invoice.number == "INV-000001").one()
    r = api.get(f"{V1}/invoices/{invoice.id}/pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert 'filename="INV-000001.pdf"' in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF") and len(r.content) > 8_000  # a subset font is inside
    # One A4 page: laid out the same way the endpoint does, then counted.
    from weasyprint import HTML  # noqa: PLC0415

    doc = documents.invoice_document(db, invoice.id)
    pages = HTML(string=pdf.render_html("invoice.html", doc, "invoice")).render().pages
    assert len(pages) == 1


@needs_pango
def test_the_statement_pdf_endpoint(api: TestClient, db: Session) -> None:
    customer_id = _load(api, db)
    r = api.get(
        f"{V1}/customers/{customer_id}/statement.pdf",
        params={"from": "2026-11-01", "to": "2026-11-30"},
    )
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert "statement-2026-11-01-2026-11-30.pdf" in r.headers["content-disposition"]


def test_document_endpoints_need_a_session_and_know_their_ids(api: TestClient) -> None:
    with new_client() as anonymous:
        assert anonymous.get(f"{V1}/invoices/{uuid.uuid4()}/pdf").status_code == 401
        assert anonymous.get(f"{V1}/customers/{uuid.uuid4()}/statement.pdf").status_code == 401
    assert api.get(f"{V1}/invoices/{uuid.uuid4()}/pdf").status_code == 404
    assert api.get(f"{V1}/customers/{uuid.uuid4()}/statement.pdf").status_code == 404

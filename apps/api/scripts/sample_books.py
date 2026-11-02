"""Makes a small, believable set of books through the running app's own API: a product with
variants, stock, a customer, a discounted sale with a payment, a part return, another payment and
a refund.

Used by the backup self-test (scripts/backup-selftest.sh) so there is something real to back up and
restore. Run inside the api container: python -m scripts.sample_books (set ADMIN_PASSWORD).
"""

import json
import os
import urllib.request
import uuid
from datetime import UTC, datetime
from typing import Any

BASE = os.environ.get("API_URL", "http://127.0.0.1:8000")
V1 = BASE + "/api/v1"


class Api:
    """A tiny client over plain HTTP (the image has no test client). The session cookie is marked
    Secure, which a cookie jar would refuse to send over http, so it is carried by hand."""

    def __init__(self) -> None:
        self.cookie = ""

    def call(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(V1 + path, data=data, method=method)
        request.add_header("X-Requested-With", "app")
        request.add_header("Content-Type", "application/json")
        if self.cookie:
            request.add_header("Cookie", self.cookie)
        with urllib.request.urlopen(request, timeout=30) as response:
            for header in response.headers.get_all("Set-Cookie") or []:
                self.cookie = header.split(";", 1)[0]
            raw = response.read()
        return json.loads(raw) if raw else None


def command(type_: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4()),
        "type": type_,
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "payload": payload,
    }


def main() -> None:
    api = Api()
    api.call("POST", "/auth/login", {"password": os.environ["ADMIN_PASSWORD"]})
    device = api.call("GET", "/auth/me")["device"]["id"]

    category = api.call("POST", "/categories", {"name": "أراجيل"})["id"]
    product = api.call("POST", "/products", {"name": "أرجيلة كبيرة", "category_id": category})["id"]
    variants = [
        api.call(
            "POST",
            f"/products/{product}/variants",
            {"color": color, "price": 4500, "min_stock": 3, "opening_qty": 40},
        )["id"]
        for color in ("أسود", "فضي")
    ]

    customer = str(uuid.uuid4())
    sale_id, line_id = str(uuid.uuid4()), str(uuid.uuid4())
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    commands = [
        command(
            "customer.upsert",
            {"customer_id": customer, "name": "محل النور", "opening_balance": 1500},
        ),
        command(
            "invoice.create",
            {
                "invoice_id": sale_id,
                "number": "INV-000001",
                "customer_id": customer,
                "issued_at": now,
                "discount": 500,
                "note": None,
                "lines": [
                    {
                        "line_id": line_id,
                        "variant_id": variants[0],
                        "qty": 3,
                        "unit_price": 4500,
                    }
                ],
                "payment": {
                    "payment_id": str(uuid.uuid4()),
                    "number": "REC-000001",
                    "amount": 5000,
                    "method": "cash",
                    "note": None,
                },
            },
        ),
        command(
            "return.create",
            {
                "return_id": str(uuid.uuid4()),
                "number": "RET-000001",
                "invoice_id": sale_id,
                "issued_at": now,
                "reason": "رجّعها الزبون",
                "lines": [
                    {
                        "return_line_id": str(uuid.uuid4()),
                        "invoice_line_id": line_id,
                        "qty": 1,
                        "disposition": "restock",
                    }
                ],
            },
        ),
        command(
            "payment.create",
            {
                "payment_id": str(uuid.uuid4()),
                "number": "REC-000002",
                "customer_id": customer,
                "paid_at": now,
                "amount": 2500,
                "method": "transfer",
                "note": None,
            },
        ),
        command(
            "refund.create",
            {
                "refund_id": str(uuid.uuid4()),
                "number": "REF-000001",
                "customer_id": customer,
                "refunded_at": now,
                "amount": 500,
                "method": "cash",
                "note": None,
            },
        ),
    ]
    pushed = api.call("POST", "/sync/push", {"device_id": device, "commands": commands})
    statuses = [r["status"] for r in pushed["results"]]
    if set(statuses) != {"applied"}:
        raise SystemExit(f"sample books were not all applied: {pushed}")
    print(f"sample books made: {len(commands)} commands applied")


if __name__ == "__main__":
    main()

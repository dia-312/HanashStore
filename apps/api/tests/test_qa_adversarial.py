"""QA: attacks and nonsense input.

None of this may crash the server (HTTP 500), leave a half-applied command, or put something in the
database that breaks a later read (a "poison pill"): a value that passes validation today must not
make the statement, the documents or the next pull fail tomorrow.
"""

import copy
import json
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from markupsafe import escape
from sqlalchemy.orm import Session

from app.main import app
from app.services import documents, pdf
from tests import helpers

V1 = "/api/v1"

# --- every route is locked, and every write needs the CSRF header -----------------------------

OPEN_ROUTES = {
    ("POST", "/api/v1/auth/login"),
    ("GET", "/api/health"),
}


def _routes() -> Iterator[tuple[str, str]]:
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in (route.methods or set()) - {"HEAD", "OPTIONS"}:
            path = route.path.replace("{invoice_id}", str(uuid.uuid4()))
            for name in ("customer_id", "product_id", "variant_id", "image_id", "device_id"):
                path = path.replace("{" + name + "}", str(uuid.uuid4()))
            yield method, path


def test_every_route_needs_a_session(client: TestClient) -> None:
    open_found = []
    for method, path in _routes():
        r = client.request(method, path, headers={"X-Requested-With": "app"}, json={})
        if r.status_code != 401:
            open_found.append((method, path, r.status_code))
    assert {(m, p) for m, p, _ in open_found} <= OPEN_ROUTES, open_found


def test_every_write_without_the_csrf_header_is_refused(api: TestClient) -> None:
    for method, path in _routes():
        if method in {"GET"}:
            continue
        r = api.request(method, path, json={}, headers={"X-Requested-With": ""})
        assert r.status_code == 403, (method, path, r.status_code)


def test_a_wrong_or_missing_session_cookie_is_not_a_session(client: TestClient) -> None:
    for cookie in ("", "x", "a" * 5000, "' OR 1=1 --", "\u0000"):
        client.cookies.clear()
        client.cookies.set("session", cookie.replace("\u0000", ""))
        r = client.get(V1 + "/auth/me")
        assert r.status_code == 401, cookie


# --- text that is HTML, SQL or control characters ---------------------------------------------

EVIL = [
    "<script>alert(1)</script>",
    '<img src="file:///etc/passwd">',
    '<img src="http://169.254.169.254/latest/meta-data/">',
    '"><svg onload=alert(1)>',
    "{{ 7*7 }}",
    "{% for x in range(9) %}x{% endfor %}",
    "'; DROP TABLE customers; --",
    "‮‭⁦ bidi",
]


def test_html_in_names_is_escaped_in_the_invoice_document(api: TestClient, db: Session) -> None:
    for evil in EVIL:
        cid = helpers.customer(api, name=evil, shop_name=evil)
        product = helpers.product(api, name=evil)
        variant = helpers.variant(api, product["id"], color=evil, size=evil)
        helpers.stock_in(api, variant["id"], 5)
        cmd = helpers.invoice_cmd(cid, [(variant["id"], 1, 1000)])
        assert helpers.push_one(api, cmd)["status"] == "applied"
        html = pdf.render_html(
            "invoice.html",
            documents.invoice_document(db, uuid.UUID(cmd["payload"]["invoice_id"])),
            "invoice",
        )
        for dangerous in ("<script", "<svg", '<img src="file', '<img src="http'):
            assert dangerous not in html, (evil, dangerous)
        # shown as text, exactly as typed, and never evaluated as a template
        assert str(escape(evil)) in html, evil
        assert "xxxxxxxxx" not in html


# --- nonsense inside commands ------------------------------------------------------------------

NASTY: list[Any] = [
    0,
    -1,
    1,
    2**31,
    2**63,
    10**30,
    1.5,
    -0.0,
    "",
    " ",
    "A" * 20_000,
    None,
    [],
    {},
    True,
    "\u0000",
    "a\u0000b",
    "<script>",
    "'; DROP TABLE users; --",
    "٣",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
    "2026-13-45T25:61:00Z",
    "9999-12-31T23:59:59Z",
    "0001-01-01T00:00:00Z",
    "1970-01-01T00:00:00Z",
]


def _leaves(node: Any, path: tuple[Any, ...] = ()) -> Iterator[tuple[Any, ...]]:
    yield path
    if isinstance(node, dict):
        for key, value in node.items():
            yield from _leaves(value, (*path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from _leaves(value, (*path, index))


def _set(node: Any, path: tuple[Any, ...], value: Any) -> Any:
    if not path:
        return value
    copy_ = copy.deepcopy(node)
    cursor = copy_
    for step in path[:-1]:
        cursor = cursor[step]
    cursor[path[-1]] = value
    return copy_


class World:
    """One of everything, so every command type has something real to point at."""

    def __init__(self, api: TestClient) -> None:
        self.api = api
        self.customer = helpers.customer(api, name="محل الفحص")
        product = helpers.product(api, name="منتج الفحص")
        self.variant = helpers.variant(api, product["id"], color="أسود", size="25")["id"]
        helpers.stock_in(api, self.variant, 500)
        self.sale = helpers.invoice_cmd(
            self.customer, [(self.variant, 3, 2000)], paid=1000, discount=100
        )
        assert helpers.push_one(api, self.sale)["status"] == "applied"
        self.invoice_id = self.sale["payload"]["invoice_id"]
        self.payment = helpers.payment_cmd(self.customer, 500)
        assert helpers.push_one(api, self.payment)["status"] == "applied"

    def corpus(self) -> list[dict[str, Any]]:
        sale2 = helpers.invoice_cmd(self.customer, [(self.variant, 2, 2500)], paid=300)
        return [
            helpers.customer_cmd(self.customer, name="تعديل", opening_balance=100),
            helpers.purchase_cmd([(self.variant, 4)], note="n"),
            {
                **helpers.command("stock.damage", {}),
                "payload": {
                    "movement_id": str(uuid.uuid4()),
                    "variant_id": self.variant,
                    "qty": 1,
                    "note": "x",
                },
            },
            helpers.command(
                "stock.adjust",
                {
                    "movement_id": str(uuid.uuid4()),
                    "variant_id": self.variant,
                    "counted_qty": 400,
                    "expected_qty": None,
                    "note": "c",
                },
            ),
            sale2,
            helpers.payment_cmd(self.customer, 700),
            helpers.void_cmd(self.payment["payload"]["payment_id"]),
            helpers.return_cmd(self.sale, [(0, 1, "restock")]),
            helpers.refund_cmd(self.customer, 400),
            helpers.command(
                "invoice.mark_delivered",
                {"invoice_id": self.invoice_id, "delivered_at": "2026-11-05T09:00:00Z"},
            ),
            helpers.command(
                "invoice.cancel",
                {
                    "invoice_id": str(uuid.uuid4()),
                    "cancelled_at": "2026-11-05T09:00:00Z",
                    "reason": "x",
                    "void_payment": False,
                    "lines": [],
                },
            ),
        ]


def _fuzz_commands(world: World) -> Iterator[tuple[dict[str, Any], str]]:
    for base in world.corpus():
        # (the payload itself must be an object: that is the envelope's rule, answered with 422)
        for path in filter(None, _leaves(base["payload"])):
            for nasty in NASTY:
                payload = _set(base["payload"], path, nasty)
                what = f"{base['type']} {'.'.join(map(str, path))} = {str(nasty)[:40]!r}"
                yield {**base, "id": str(uuid.uuid4()), "payload": payload}, what


def test_nonsense_in_any_field_of_any_command_never_crashes_the_server(api: TestClient) -> None:
    world = World(api)
    device = helpers.device_id(api)
    seen: dict[str, int] = {}
    crashes: list[str] = []
    batch: list[tuple[dict[str, Any], str]] = []

    def push(items: list[tuple[dict[str, Any], str]]) -> bool:
        r = api.post(
            V1 + "/sync/push", json={"device_id": device, "commands": [c for c, _ in items]}
        )
        if r.status_code != 200:
            return False
        for (_, what), result in zip(items, r.json()["results"], strict=True):
            if result["status"] not in {"applied", "rejected"}:
                crashes.append(f"{what}: {result}")
                continue
            seen[result["status"]] = seen.get(result["status"], 0) + 1
            if result["status"] == "rejected" and not result["error"]["code"]:
                crashes.append(f"{what}: rejection without a code")
        return True

    def flush() -> None:
        if batch and not push(batch):
            # the whole request failed: find the command(s) that did it
            for one in batch:
                if not push([one]):
                    crashes.append(f"HTTP failure for {one[1]}")
        batch.clear()

    for item in _fuzz_commands(world):
        batch.append(item)
        if len(batch) == 20:
            flush()
    flush()
    assert not crashes, f"{len(crashes)} bad answers, first ones: {crashes[:12]}"
    assert seen.get("rejected", 0) > 1000  # the nonsense was really refused, not ignored
    assert seen.get("applied", 0) > 0

    # ---- nothing that was accepted may break a read afterwards (poison pills) ----
    page = api.get(V1 + "/sync/pull", params={"cursor": 0})
    assert page.status_code == 200, page.text[:300]
    body = page.json()
    json.dumps(body)
    for c in body["changes"]["customers"]:
        for params in ({}, {"from": "2000-01-01", "to": "2100-01-01", "include_cancelled": True}):
            r = api.get(f"{V1}/customers/{c['id']}/statement", params=params)
            assert r.status_code == 200, (c["id"], params, r.text[:300])
    assert api.get(V1 + "/sync/numbers").status_code == 200
    assert api.get(V1 + "/products").status_code == 200


@pytest.mark.parametrize("bad", ["\u0000", "a\u0000b"])
def test_a_nul_character_is_refused_not_a_500(api: TestClient, bad: str) -> None:
    cmd = helpers.customer_cmd(name=bad)
    result = helpers.push_one(api, cmd)
    assert result["status"] == "rejected"
    r = api.post(V1 + "/categories", json={"name": bad})
    assert r.status_code in {400, 422}, r.status_code
    r = api.get(V1 + "/products", params={"q": bad})
    assert r.status_code in {200, 400, 422}, r.status_code


# --- nonsense in REST bodies and query strings --------------------------------------------------


def _rest_cases(api: TestClient) -> list[tuple[str, str, dict[str, Any]]]:
    cat = helpers.category(api, "فئة الفحص")
    prod = helpers.product(api, "منتج", category_id=cat["id"])
    var = helpers.variant(api, prod["id"], color="أسود", size="1")
    return [
        ("POST", "/categories", {"name": "جديدة"}),
        ("PATCH", f"/categories/{cat['id']}", {"name": "اسم", "sort_order": 1, "is_active": True}),
        ("POST", "/products", {"name": "م", "category_id": cat["id"], "description": "و"}),
        (
            "PATCH",
            f"/products/{prod['id']}",
            {"name": "م", "category_id": cat["id"], "description": "d", "is_active": True},
        ),
        (
            "POST",
            f"/products/{prod['id']}/variants",
            {"color": "c", "size": "s", "price": 100, "min_stock": 1, "opening_qty": 1},
        ),
        (
            "PATCH",
            f"/variants/{var['id']}",
            {"color": "c", "size": "s", "price": 100, "min_stock": 1, "is_active": True},
        ),
        ("PATCH", "/settings", {"business_name": "ب", "phone": "1", "invoice_footer": "f"}),
        ("PUT", "/synonyms", {"groups": [{"terms": ["فحم", "فحمات"]}]}),
    ]


def test_nonsense_in_rest_bodies_is_a_clean_4xx(api: TestClient) -> None:
    bad: list[str] = []
    for method, path, body in _rest_cases(api):
        for leaf in filter(None, _leaves(body)):
            for nasty in NASTY:
                r = api.request(method, V1 + path, json=_set(body, leaf, nasty))
                if r.status_code >= 500:
                    bad.append(f"{method} {path} {'.'.join(map(str, leaf))}={str(nasty)[:30]!r}")
    assert not bad, f"{len(bad)} server errors, first ones: {bad[:12]}"


QUERY_NASTY = [
    "",
    "-1",
    "0",
    "99999999999999999999",
    "1.5",
    "abc",
    "\u0000",
    "%00",
    "' OR 1=1 --",
    "A" * 5000,
    "!!!",
    "====",
    "e30=",  # base64 of {}
    "WyJhIiwgImIiXQ==",  # base64 of ["a", "b"]
    "not-a-uuid",
    "9999-99-99",
    "0001-01-01",
    "2026-02-30",
]


def test_nonsense_in_query_strings_is_a_clean_4xx(api: TestClient) -> None:
    ids = helpers.category(api)["id"], str(uuid.uuid4())
    cust = helpers.customer(api)
    var = helpers.variant(api, helpers.product(api)["id"])["id"]
    gets = {
        "/products": ["q", "category_id", "include_inactive", "cursor", "limit"],
        "/variants": ["q", "cursor", "limit"],
        f"/variants/{var}/movements": ["cursor", "limit"],
        "/sync/pull": ["cursor"],
        f"/customers/{cust}/statement": ["from", "to", "include_cancelled"],
        "/categories": ["include_inactive"],
    }
    bad: list[str] = []
    for path, params in gets.items():
        for name in params:
            for nasty in QUERY_NASTY:
                r = api.get(V1 + path, params={name: nasty})
                if r.status_code >= 500:
                    bad.append(f"GET {path}?{name}={nasty[:25]!r} -> {r.status_code}")
    assert ids and not bad, f"{len(bad)} server errors, first ones: {bad[:12]}"

import io
from typing import Any

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog
from app.services import settings
from tests.conftest import new_client

V1 = "/api/v1"


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (40, 30), (20, 33, 61)).save(out, "PNG")
    return out.getvalue()


def test_every_settings_route_needs_a_session() -> None:
    with new_client() as c:
        assert c.get(V1 + "/settings").status_code == 401
        assert c.patch(V1 + "/settings", json={}).status_code == 401
        assert (
            c.post(
                V1 + "/settings/logo", files={"file": ("l.png", _png(), "image/png")}
            ).status_code
            == 401
        )


def test_defaults_are_placeholders_until_the_client_gives_his_details(api: TestClient) -> None:
    body: dict[str, Any] = api.get(V1 + "/settings").json()
    assert body == settings.DEFAULTS
    assert body["logo_url"] is None and body["phone"] == ""
    assert body["hide_out_of_stock_in_presentation"] is True


def test_changing_the_business_details_is_saved_and_audited(api: TestClient, db: Session) -> None:
    r = api.patch(
        V1 + "/settings",
        json={
            "business_name": "  شركة النور  ",
            "phone": "0599123456",
            "invoice_footer": "شكراً لتعاملكم",
        },
    )
    assert r.status_code == 200
    assert (r.json()["business_name"], r.json()["phone"]) == ("شركة النور", "0599123456")
    assert api.get(V1 + "/settings").json()["invoice_footer"] == "شكراً لتعاملكم"
    rows = db.scalars(select(AuditLog).where(AuditLog.entity == "settings")).all()
    assert len(rows) == 1  # one change, one audit row


def test_saving_the_same_values_again_writes_no_audit_row(api: TestClient, db: Session) -> None:
    api.patch(V1 + "/settings", json={"phone": "0599"})
    api.patch(V1 + "/settings", json={"phone": "0599"})
    assert len(db.scalars(select(AuditLog).where(AuditLog.entity == "settings")).all()) == 1


def test_only_known_keys_with_sane_values_are_accepted(api: TestClient) -> None:
    assert api.patch(V1 + "/settings", json={"business_name": "x" * 201}).status_code == 422
    assert (
        api.patch(V1 + "/settings", json={"hide_out_of_stock_in_presentation": "yes"}).status_code
        == 422
    )
    r = api.patch(V1 + "/settings", json={"evil_key": "x", "phone": "1"})
    assert r.status_code == 200 and "evil_key" not in r.json()


def test_the_presentation_switch_is_a_boolean(api: TestClient) -> None:
    r = api.patch(V1 + "/settings", json={"hide_out_of_stock_in_presentation": False})
    assert r.json()["hide_out_of_stock_in_presentation"] is False


def test_the_logo_is_re_encoded_stored_and_can_be_removed(api: TestClient) -> None:
    r = api.post(V1 + "/settings/logo", files={"file": ("logo.png", _png(), "image/png")})
    assert r.status_code == 200
    url = r.json()["logo_url"]
    assert url.startswith("/media/settings/logo-") and url.endswith(".webp")
    served = api.get(url)
    assert served.status_code == 200 and served.content[:4] == b"RIFF"  # WebP, not the original
    assert api.patch(V1 + "/settings", json={"logo_url": None}).json()["logo_url"] is None


def test_a_logo_that_is_not_an_image_is_refused(api: TestClient) -> None:
    r = api.post(V1 + "/settings/logo", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 422
    assert api.get(V1 + "/settings").json()["logo_url"] is None


def test_the_pull_carries_the_settings(api: TestClient) -> None:
    api.patch(V1 + "/settings", json={"business_name": "شركة النور"})
    page = api.get(V1 + "/sync/pull", params={"cursor": 0}).json()
    assert page["settings"]["business_name"] == "شركة النور"

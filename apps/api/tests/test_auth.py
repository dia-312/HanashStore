from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app import clock
from app.db import get_engine
from app.models import AuthSession, SyncClock, User
from app.security import verify_secret
from tests.conftest import PASSWORD, new_client

pytestmark = pytest.mark.usefixtures("user")


def login(client: TestClient, **extra: object) -> httpx.Response:
    response: httpx.Response = client.post(
        "/api/v1/auth/login", json={"password": PASSWORD, **extra}
    )
    return response


def test_login_sets_a_locked_down_cookie(client: TestClient) -> None:
    r = login(client, device_name="iPad Pro")
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["name"] == "Rep"
    assert body["device"]["name"] == "iPad Pro"
    assert body["has_pin"] is False
    cookie = r.headers["set-cookie"].lower()
    for flag in ("httponly", "secure", "samesite=lax", f"max-age={30 * 86400}", "path=/"):
        assert flag in cookie


def test_wrong_password_is_401(client: TestClient) -> None:
    r = client.post("/api/v1/auth/login", json={"password": "nope"})
    assert r.status_code == 401
    assert r.json()["code"] == "INVALID_CREDENTIALS"
    assert "set-cookie" not in r.headers


def test_lockout_after_five_failures_blocks_even_the_right_password(client: TestClient) -> None:
    for _ in range(4):
        assert client.post("/api/v1/auth/login", json={"password": "bad"}).status_code == 401
    fifth = client.post("/api/v1/auth/login", json={"password": "bad"})
    assert fifth.status_code == 429
    assert fifth.json()["code"] == "RATE_LIMITED"
    assert int(fifth.headers["retry-after"]) > 800
    assert login(client).status_code == 429


def test_csrf_header_is_required_for_writes_only(client: TestClient) -> None:
    bare = TestClient(client.app, base_url="https://testserver")
    r = bare.post("/api/v1/auth/login", json={"password": PASSWORD})
    assert r.status_code == 403
    assert r.json()["code"] == "CSRF_REJECTED"
    assert bare.get("/api/v1/auth/me").status_code == 401  # reads are not blocked by CSRF


def test_every_response_has_server_time(client: TestClient) -> None:
    for r in (
        client.get("/api/health"),
        client.get("/api/v1/auth/me"),
        TestClient(client.app).post("/api/v1/auth/login", json={}),  # no CSRF header: 403
    ):
        assert r.headers["x-server-time"].endswith("+00:00")


def test_me_requires_login_then_returns_identity(client: TestClient) -> None:
    assert client.get("/api/v1/auth/me").json()["code"] == "UNAUTHENTICATED"
    login(client)
    me = client.get("/api/v1/auth/me").json()
    assert me["user"]["name"] == "Rep" and me["has_pin"] is False


def test_logout_ends_only_this_session(client: TestClient) -> None:
    login(client)
    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_logout_all_ends_every_session(client: TestClient) -> None:
    login(client)
    other = new_client()
    other.post("/api/v1/auth/login", json={"password": PASSWORD, "confirm_replace": True})
    assert client.get("/api/v1/auth/me").status_code == 401  # revoked by the second login
    assert other.post("/api/v1/auth/logout-all").status_code == 204
    assert other.get("/api/v1/auth/me").status_code == 401
    with get_engine().connect() as conn:
        assert conn.scalar(text("SELECT count(*) FROM sessions")) == 0


def test_second_device_needs_confirmation_and_revokes_the_first(client: TestClient) -> None:
    login(client, device_name="old iPad")
    second = new_client()
    r = second.post("/api/v1/auth/login", json={"password": PASSWORD, "device_name": "new iPad"})
    assert r.status_code == 409
    assert r.json()["code"] == "DEVICE_REPLACE_CONFIRM"
    assert r.json()["details"]["active_device"]["name"] == "old iPad"
    assert client.get("/api/v1/auth/me").status_code == 200  # nothing changed yet

    ok = second.post(
        "/api/v1/auth/login",
        json={"password": PASSWORD, "device_name": "new iPad", "confirm_replace": True},
    )
    assert ok.status_code == 200
    revoked = client.get("/api/v1/auth/me")
    assert revoked.status_code == 401
    assert revoked.json()["code"] == "DEVICE_REVOKED"


def test_known_device_logs_in_again_without_confirmation(client: TestClient) -> None:
    first = login(client).json()
    client.post("/api/v1/auth/logout")
    again = login(client, device_id=first["device"]["id"]).json()
    assert again["device"]["id"] == first["device"]["id"]


def test_a_revoked_device_id_registers_as_a_new_device(client: TestClient) -> None:
    first = login(client).json()
    other = new_client()
    other.post("/api/v1/auth/login", json={"password": PASSWORD, "confirm_replace": True})
    r = client.post(
        "/api/v1/auth/login",
        json={"password": PASSWORD, "device_id": first["device"]["id"], "confirm_replace": True},
    )
    assert r.status_code == 200
    assert r.json()["device"]["id"] != first["device"]["id"]


def test_devices_list_and_revoke(client: TestClient) -> None:
    me = login(client).json()
    devices = client.get("/api/v1/devices").json()
    assert [d["is_current"] for d in devices] == [True]
    assert client.post(f"/api/v1/devices/{me['device']['id']}/revoke").status_code == 204
    assert client.get("/api/v1/devices").json()["code"] == "DEVICE_REVOKED"


def test_revoking_an_unknown_device_is_404(client: TestClient) -> None:
    login(client)
    r = client.post("/api/v1/devices/00000000-0000-7000-8000-000000000000/revoke")
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"


@pytest.mark.parametrize("pin", ["123", "1234567", "12ab", "", "١٢٣٤"])
def test_pin_must_be_4_to_6_latin_digits(client: TestClient, pin: str) -> None:
    login(client)
    r = client.put("/api/v1/auth/pin", json={"pin": pin})
    assert r.status_code == 422
    assert r.json()["code"] == "VALIDATION_ERROR"
    assert r.json()["details"]["errors"][0]["field"] == "body.pin"


def test_pin_is_stored_hashed(client: TestClient, db: Session) -> None:
    login(client)
    assert client.put("/api/v1/auth/pin", json={"pin": "4821"}).status_code == 204
    assert client.get("/api/v1/auth/me").json()["has_pin"] is True
    stored = db.scalars(select(User)).one().pin_hash
    assert stored is not None and "4821" not in stored and verify_secret(stored, "4821")


def test_change_password(client: TestClient) -> None:
    login(client)
    bad = client.put(
        "/api/v1/auth/password",
        json={"current_password": "x", "new_password": "a brand new password"},
    )
    assert bad.status_code == 401
    short = client.put(
        "/api/v1/auth/password", json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert short.status_code == 422
    ok = client.put(
        "/api/v1/auth/password",
        json={"current_password": PASSWORD, "new_password": "a brand new password"},
    )
    assert ok.status_code == 204
    fresh = new_client()
    assert fresh.post("/api/v1/auth/login", json={"password": PASSWORD}).status_code == 401
    assert (
        fresh.post(
            "/api/v1/auth/login",
            json={"password": "a brand new password", "confirm_replace": True},
        ).status_code
        == 200
    )


def test_session_slides_while_used_and_expires_when_idle(
    client: TestClient, db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    login(client)
    start = clock.utcnow()
    monkeypatch.setattr(clock, "utcnow", lambda: start + timedelta(days=20))
    r = client.get("/api/v1/auth/me")
    assert r.status_code == 200
    assert "max-age" in r.headers["set-cookie"].lower()  # cookie lifetime renewed too
    db.expire_all()
    expires = db.scalars(select(AuthSession)).one().expires_at
    assert expires >= start + timedelta(days=49)  # 20 days used + a fresh 30

    monkeypatch.setattr(clock, "utcnow", lambda: start + timedelta(days=20 + 31))
    assert client.get("/api/v1/auth/me").status_code == 401


def test_validation_errors_use_the_standard_shape(client: TestClient) -> None:
    r = client.post("/api/v1/auth/login", json={})
    assert r.status_code == 422
    body = r.json()
    assert set(body) == {"code", "message", "details"}
    assert body["details"]["errors"][0]["field"] == "body.password"


def test_health_checks_the_database(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_migration_seeds_the_sync_clock(db: Session) -> None:
    row = db.get(SyncClock, 1)
    assert row is not None and row.last_seq == 0

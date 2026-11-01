import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]


def _test_database_url() -> str:
    if url := os.environ.get("TEST_DATABASE_URL"):
        return url
    password = "sales"
    env_file = API_DIR.parents[1] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                password = line.split("=", 1)[1].strip()
    return f"postgresql+psycopg://sales:{password}@127.0.0.1:5432/sales_test"


# Settings are read once, so this must run before anything imports app.config.
os.environ["DATABASE_URL"] = _test_database_url()
os.environ["COOKIE_SECURE"] = "true"
os.environ["MEDIA_DIR"] = tempfile.mkdtemp(prefix="sales-media-")
os.environ["PDF_WARM_UP"] = "false"
os.environ["ARGON2_TIME_COST"] = "1"
os.environ["ARGON2_MEMORY_KIB"] = "64"

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.cli import create_user  # noqa: E402
from app.db import get_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.ratelimit import LoginLimiter  # noqa: E402

PASSWORD = "correct horse battery"


def _ensure_database() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    admin = create_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(
            text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": url.database}
        )
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{url.database}"'))
    admin.dispose()


@pytest.fixture(scope="session", autouse=True)
def _migrated_database() -> Iterator[None]:
    _ensure_database()
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    cfg = Config(str(API_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    command.upgrade(cfg, "head")
    yield


@pytest.fixture(autouse=True)
def _clean_tables(_migrated_database: None) -> None:
    with get_engine().begin() as conn:
        conn.execute(
            text(
                "TRUNCATE audit_log, processed_commands, payments, invoice_lines, invoices,"
                " customers, stock_movements, product_images, product_variants, products,"
                " categories, sessions, devices, users, settings"
            )
        )
        conn.execute(text("UPDATE sync_clock SET last_seq = 0"))
        conn.execute(text("ALTER SEQUENCE sku_seq RESTART"))
    app.state.login_limiter = LoginLimiter()


@pytest.fixture
def db() -> Iterator[Session]:
    with Session(get_engine()) as session:
        yield session


def new_client() -> TestClient:
    # https so the Secure session cookie is sent back; the header is what the CSRF check wants.
    return TestClient(app, base_url="https://testserver", headers={"X-Requested-With": "app"})


@pytest.fixture
def client() -> Iterator[TestClient]:
    with new_client() as c:
        yield c


@pytest.fixture
def user(db: Session) -> None:
    create_user(db, "Rep", PASSWORD)


@pytest.fixture
def api(client: TestClient, user: None) -> TestClient:
    """A client that is already logged in."""
    r = client.post("/api/v1/auth/login", json={"password": PASSWORD})
    assert r.status_code == 200
    return client

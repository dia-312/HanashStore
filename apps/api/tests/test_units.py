import uuid

import pytest
from sqlalchemy.orm import Session

from app.cli import create_user
from app.ids import uuid7
from app.ratelimit import LoginLimiter
from app.security import hash_secret, hash_token, new_session_token, verify_secret


def test_uuid7_layout_and_order() -> None:
    a, b = uuid7(1_700_000_000_000), uuid7(1_700_000_000_001)
    assert a.version == 7
    assert a.variant == uuid.RFC_4122
    assert a.int >> 80 == 1_700_000_000_000  # timestamp sits in the top 48 bits
    assert str(a) < str(b)  # later ms sorts later as text, which is what the DB index sees
    assert len({uuid7() for _ in range(1000)}) == 1000


def test_secret_hash_roundtrip() -> None:
    h = hash_secret("1234")
    assert h.startswith("$argon2id$")
    assert h != hash_secret("1234")  # random salt
    assert verify_secret(h, "1234")
    assert not verify_secret(h, "1235")
    assert not verify_secret("not-a-hash", "1234")


def test_tokens() -> None:
    t1, t2 = new_session_token(), new_session_token()
    assert t1 != t2 and len(t1) >= 40
    assert hash_token(t1) == hash_token(t1) != hash_token(t2)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_limiter_locks_after_five_failures_then_releases() -> None:
    clock = FakeClock()
    limiter = LoginLimiter(clock=clock)
    for _ in range(4):
        limiter.record_failure("ip")
    assert limiter.retry_after("ip") == 0
    limiter.record_failure("ip")
    assert 890 < limiter.retry_after("ip") <= 901
    assert limiter.retry_after("other") == 0
    clock.now += 901
    assert limiter.retry_after("ip") == 0


def test_limiter_window_forgets_old_failures() -> None:
    clock = FakeClock()
    limiter = LoginLimiter(clock=clock)
    for _ in range(4):
        limiter.record_failure("ip")
    clock.now += 61
    limiter.record_failure("ip")
    assert limiter.retry_after("ip") == 0


def test_limiter_reset_clears_state() -> None:
    limiter = LoginLimiter(clock=FakeClock())
    for _ in range(5):
        limiter.record_failure("ip")
    limiter.reset("ip")
    assert limiter.retry_after("ip") == 0


def test_create_user_rules(db: Session) -> None:
    with pytest.raises(ValueError, match="at least"):
        create_user(db, "Rep", "short")
    create_user(db, "Rep", "long enough password")
    with pytest.raises(ValueError, match="exactly one"):
        create_user(db, "Second", "another long password")

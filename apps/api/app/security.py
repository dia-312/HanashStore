import hashlib
import secrets
from functools import lru_cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.config import get_settings


@lru_cache
def _hasher() -> PasswordHasher:
    s = get_settings()
    return PasswordHasher(time_cost=s.argon2_time_cost, memory_cost=s.argon2_memory_kib)


def hash_secret(secret: str) -> str:
    """argon2id with a random salt. Used for the password and for the PIN."""
    return _hasher().hash(secret)


def verify_secret(stored_hash: str, secret: str) -> bool:
    try:
        return _hasher().verify(stored_hash, secret)
    except (VerificationError, InvalidHashError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

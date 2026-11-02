"""Cursor pagination (SPEC section 12): `?cursor=&limit=`, default 50, max 200, keyset based."""

import base64
import json
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Annotated, Any

from fastapi import Query

from app.errors import ApiError

DEFAULT_LIMIT = 50
MAX_LIMIT = 200

Limit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]


def encode_cursor(values: list[Any]) -> str:
    raw = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def as_str(value: Any) -> str:
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError(value)
    return value


def as_uuid(value: Any) -> uuid.UUID:
    return uuid.UUID(as_str(value))


def as_datetime(value: Any) -> datetime:
    return datetime.fromisoformat(as_str(value))


def decode_cursor(cursor: str, *kinds: Callable[[Any], Any]) -> list[Any]:
    """The values a cursor carries, each converted by `kinds` (as_str, as_uuid, as_datetime). A
    cursor is only ever made by us, but anyone can type one: whatever is wrong with it is a 422."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        values = json.loads(raw)
        if not isinstance(values, list) or len(values) != len(kinds):
            raise ValueError(cursor)
        return [kind(value) for kind, value in zip(kinds, values, strict=True)]
    except (ValueError, TypeError, OverflowError) as exc:
        raise ApiError(422, "BAD_CURSOR", "Invalid cursor") from exc

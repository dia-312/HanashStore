"""Cursor pagination (SPEC section 12): `?cursor=&limit=`, default 50, max 200, keyset based."""

import base64
import json
from typing import Annotated, Any

from fastapi import Query

from app.errors import ApiError

DEFAULT_LIMIT = 50
MAX_LIMIT = 200

Limit = Annotated[int, Query(ge=1, le=MAX_LIMIT)]


def encode_cursor(values: list[Any]) -> str:
    raw = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, size: int) -> list[Any]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        values = json.loads(raw)
    except ValueError as exc:
        raise ApiError(422, "BAD_CURSOR", "Invalid cursor") from exc
    if not isinstance(values, list) or len(values) != size:
        raise ApiError(422, "BAD_CURSOR", "Invalid cursor")
    return values

"""Where product images live. Local disk now; R2 arrives with the production deploy (M9) by
replacing this one module. Written by the API, served at /media by Caddy (and by the API in dev)."""

import os
import uuid
from pathlib import Path

from app.config import get_settings

URL_PREFIX = "/media"


def media_root() -> Path:
    root = Path(get_settings().media_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def image_paths(product_id: uuid.UUID, image_id: uuid.UUID) -> tuple[str, str]:
    """(thumb, full) paths relative to the media root. Built from ids only, never user input."""
    base = f"products/{product_id}/{image_id}"
    return f"{base}-thumb.webp", f"{base}-full.webp"


def write_media(relative: str, data: bytes) -> str:
    """Write atomically (a half-written file is never served) and return the public URL."""
    target = media_root() / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + f".{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return f"{URL_PREFIX}/{relative}"

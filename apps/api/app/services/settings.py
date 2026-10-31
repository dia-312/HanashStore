"""Business settings (SPEC section 6): what appears on invoices and one presentation switch.

Stored as key/value rows. A key with no row has its default, so nothing needs seeding. The client's
real name, phone and logo are still pending (SPEC section 16): the defaults are placeholders."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.ids import uuid7
from app.models import Setting

DEFAULTS: dict[str, Any] = {
    "business_name": "اسم المنشأة",
    "phone": "",
    "invoice_footer": "",
    "logo_url": None,
    "hide_out_of_stock_in_presentation": True,
}


def get_all(db: Session) -> dict[str, Any]:
    values = dict(DEFAULTS)
    for row in db.scalars(select(Setting)):
        if row.key in DEFAULTS:
            values[row.key] = row.value
    return values


def update(db: Session, changes: dict[str, Any]) -> dict[str, Any]:
    """Apply the given keys; returns every setting. Unknown keys are never stored."""
    before = get_all(db)
    now = clock.utcnow()
    for key, value in changes.items():
        if key not in DEFAULTS or before[key] == value:
            continue
        row = db.get(Setting, key)
        if row is None:
            db.add(Setting(key=key, value=value, updated_at=now))
        else:
            row.value = value
            row.updated_at = now
    after = get_all(db)
    if after != before:
        audit(db, "settings", uuid7(), "update", before=before, after=after)
    return after

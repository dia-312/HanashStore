import uuid
from typing import Any

from sqlalchemy.orm import Session

from app import clock
from app.ids import uuid7
from app.models import AuditLog


def audit(
    db: Session,
    entity: str,
    entity_id: uuid.UUID,
    action: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    device_id: uuid.UUID | None = None,
) -> None:
    """One audit row (SPEC section 13): price changes, deactivations, stock movements, imports."""
    db.add(
        AuditLog(
            id=uuid7(),
            entity=entity,
            entity_id=entity_id,
            action=action,
            before=before,
            after=after,
            device_id=device_id,
            created_at=clock.utcnow(),
        )
    )

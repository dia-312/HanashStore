import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.models import Device

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceInfo(BaseModel):
    id: uuid.UUID
    name: str
    is_current: bool
    last_seen_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


@router.get("", response_model=list[DeviceInfo])
def list_devices(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[DeviceInfo]:
    rows = db.scalars(select(Device).order_by(Device.created_at.desc())).all()
    return [
        DeviceInfo(
            id=d.id,
            name=d.name,
            is_current=d.id == auth.device.id,
            last_seen_at=d.last_seen_at,
            revoked_at=d.revoked_at,
            created_at=d.created_at,
        )
        for d in rows
    ]


@router.post("/{device_id}/revoke", status_code=204)
def revoke_device(
    device_id: uuid.UUID,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> None:
    device = db.get(Device, device_id)
    if device is None:
        raise ApiError(404, "NOT_FOUND", "Device not found")
    if device.revoked_at is None:
        device.revoked_at = clock.utcnow()
        db.commit()

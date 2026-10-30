"""Sync endpoints (SPEC sections 8 and 12). The device pulls changed rows and pushes commands."""

from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.schemas import PullPage, PushRequest
from app.services import sync

router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/pull", response_model=PullPage)
def pull(
    cursor: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> PullPage:
    return sync.pull(db, cursor)


@router.post("/push")
def push(
    body: PushRequest,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    if body.device_id != auth.device.id:
        raise ApiError(403, "DEVICE_MISMATCH", "These commands belong to another device")
    results, cursor = sync.push(db, auth.device, body.commands)
    return {"results": results, "cursor": cursor}

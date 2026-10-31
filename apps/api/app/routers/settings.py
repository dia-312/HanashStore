"""Business settings and the logo (SPEC section 12). Online only, like catalog editing."""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, StrictBool, StringConstraints
from sqlalchemy.orm import Session

from app import storage
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.services import images, settings

router = APIRouter(prefix="/settings", tags=["settings"])

Line = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Footer = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class SettingsPatch(BaseModel):
    business_name: Line | None = None
    phone: Line | None = None
    invoice_footer: Footer | None = None
    hide_out_of_stock_in_presentation: StrictBool | None = None
    # Only to remove the logo (null); a new one goes through POST /settings/logo.
    logo_url: None = None


@router.get("")
def read(
    db: Session = Depends(get_db), _auth: AuthContext = Depends(current_auth)
) -> dict[str, Any]:
    return settings.get_all(db)


@router.patch("")
def patch(
    body: SettingsPatch,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    changes = {
        key: getattr(body, key)
        for key in body.model_fields_set
        if key in settings.DEFAULTS and (key == "logo_url" or getattr(body, key) is not None)
    }
    result = settings.update(db, changes)
    db.commit()
    return result


@router.post("/logo")
async def upload_logo(
    file: Annotated[UploadFile, File()],
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    processed = images.process_upload(await file.read())
    # A new name each time, so browsers and the service worker never keep an old logo.
    url = storage.write_media(f"settings/logo-{uuid.uuid4().hex}.webp", processed.full)
    result = settings.update(db, {"logo_url": url})
    db.commit()
    return result

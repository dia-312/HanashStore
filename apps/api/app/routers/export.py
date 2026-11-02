"""Export all the data as a ZIP of CSV files (SPEC F13). Online only; the rep downloads it."""

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.ids import uuid7
from app.services import export
from app.services.export import HEBRON

router = APIRouter(prefix="/export", tags=["export"])


@router.get("")
def export_all(
    db: Session = Depends(get_db), auth: AuthContext = Depends(current_auth)
) -> Response:
    content, counts = export.build(db)
    audit(db, "export", uuid7(), "download", after=counts, device_id=auth.device.id)
    db.commit()
    day = clock.utcnow().astimezone(HEBRON).strftime("%Y-%m-%d")
    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="hanash-export-{day}.zip"',
            "Cache-Control": "no-store",
        },
    )

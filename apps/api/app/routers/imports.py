"""POST /import/products?dry_run=true|false (SPEC section 12). Flagged for line-by-line review."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.schemas import ImportReport
from app.services import importer

router = APIRouter(prefix="/import", tags=["import"])


@router.post("/products", response_model=ImportReport)
def import_products(
    file: Annotated[UploadFile, File()],
    dry_run: bool = True,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> ImportReport:
    """Dry run (the default) reports what would happen. A real run applies everything or, when any
    row has an error, nothing at all (HTTP 422 with the same report in `details`)."""
    data = file.file.read(importer.MAX_BYTES + 1)
    report, applied = importer.run_import(db, data, dry_run=dry_run, device_id=auth.device.id)
    body = ImportReport(
        dry_run=dry_run,
        committed=applied,
        rows=report.rows,
        mapped_columns=report.mapped,
        ignored_columns=report.ignored,
        errors=report.errors,
        errors_total=report.errors_total,
        new_categories=report.new_categories,
        new_products=report.new_products,
        new_variants=report.new_variants,
        skipped_existing=report.skipped_existing,
        opening_units=report.opening_units,
        preview=report.preview,
    )
    if not dry_run and report.errors_total:
        db.rollback()
        raise ApiError(
            422, "IMPORT_HAS_ERRORS", "Fix the rows with errors and try again", body.model_dump()
        )
    if applied:
        db.commit()
    return body

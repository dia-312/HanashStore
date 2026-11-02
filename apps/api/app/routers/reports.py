"""Reports (SPEC F12). Read only, online only, computed from the books."""

from dataclasses import asdict
from datetime import date, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import AuthContext, current_auth
from app.services import reports

router = APIRouter(prefix="/reports", tags=["reports"])


def _period(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    """Both ends included. Left out: from the first of this month to today."""
    end = date_to or reports.today()
    start = date_from or end.replace(day=1)
    return start, end


@router.get("/sales")
def sales(
    group: Literal["day", "month"] = "day",
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    start, end = _period(date_from, date_to)
    report = reports.sales(db, start, end, group)
    return {
        **asdict(report),
        "net": report.net,
        "rows": [{**asdict(r), "net": r.net} for r in report.rows],
    }


@router.get("/products")
def products(
    by: Literal["product", "variant", "category"] = "product",
    order: Literal["top", "slow"] = "top",
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    start, end = _period(date_from, date_to)
    return asdict(reports.products(db, start, end, by, order, limit))


@router.get("/collections")
def collections(
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    start, end = _period(date_from, date_to)
    report = reports.collections(db, start, end)
    return {
        **asdict(report),
        "net": report.net,
        "by_method": [{**asdict(r), "net": r.net} for r in report.by_method],
        "by_day": [{**asdict(r), "net": r.net} for r in report.by_day],
    }


@router.get("/balances")
def balances(
    db: Session = Depends(get_db), _auth: AuthContext = Depends(current_auth)
) -> dict[str, Any]:
    return asdict(reports.balances(db))


@router.get("/stock")
def stock(
    db: Session = Depends(get_db), _auth: AuthContext = Depends(current_auth)
) -> dict[str, Any]:
    return asdict(reports.stock(db))


@router.get("/damaged")
def damaged(
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> dict[str, Any]:
    end = date_to or reports.today()
    start = date_from or end - timedelta(days=89)
    return asdict(reports.damaged(db, start, end))

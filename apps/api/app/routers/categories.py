import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.errors import ApiError
from app.models import Category, Product
from app.normalize import normalize_arabic
from app.schemas import CategoryCreate, CategoryOut, CategoryPatch
from app.services import catalog

router = APIRouter(prefix="/categories", tags=["categories"])


def _out(db: Session, category: Category) -> CategoryOut:
    count = db.scalar(
        select(func.count())
        .select_from(Product)
        .where(Product.category_id == category.id, Product.is_active.is_(True))
    )
    return CategoryOut(
        id=category.id,
        name=category.name,
        sort_order=category.sort_order,
        is_active=category.is_active,
        product_count=count or 0,
    )


def _check_name_free(db: Session, name: str, except_id: uuid.UUID | None = None) -> None:
    other = catalog.find_category_by_name(db, name)
    if other is not None and other.id != except_id:
        raise ApiError(409, "DUPLICATE_CATEGORY", "A category with this name already exists")


@router.get("", response_model=list[CategoryOut])
def list_categories(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    _auth: AuthContext = Depends(current_auth),
) -> list[CategoryOut]:
    counts = (
        select(Product.category_id, func.count().label("n"))
        .where(Product.is_active.is_(True))
        .group_by(Product.category_id)
        .subquery()
    )
    query = select(Category, func.coalesce(counts.c.n, 0)).outerjoin(
        counts, counts.c.category_id == Category.id
    )
    if not include_inactive:
        query = query.where(Category.is_active.is_(True))
    rows = db.execute(query.order_by(Category.sort_order, Category.name, Category.id)).all()
    return [
        CategoryOut(
            id=c.id,
            name=c.name,
            sort_order=c.sort_order,
            is_active=c.is_active,
            product_count=int(n),
        )
        for c, n in rows
    ]


@router.post("", response_model=CategoryOut, status_code=201)
def create_category(
    body: CategoryCreate,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> CategoryOut:
    _check_name_free(db, body.name)
    category = catalog.create_category(db, body.name, take_seq(db), auth.device.id)
    db.commit()
    return _out(db, category)


@router.patch("/{category_id}", response_model=CategoryOut)
def patch_category(
    category_id: uuid.UUID,
    body: CategoryPatch,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> CategoryOut:
    category = db.get(Category, category_id)
    if category is None:
        raise ApiError(404, "NOT_FOUND", "Category not found")
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    if "name" in changes and normalize_arabic(changes["name"]) != normalize_arabic(category.name):
        _check_name_free(db, changes["name"], category.id)
    if changes:
        catalog.update_category(db, category, changes, take_seq(db), auth.device.id)
        db.commit()
    return _out(db, category)

"""Synonym groups (SPEC sections 6 and 9): words the rep treats as the same thing when searching.

Terms are stored normalized. The whole list is saved at once; a group missing from the list is
switched off (never deleted) so devices pull the removal.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.audit import audit
from app.errors import ApiError
from app.ids import uuid7
from app.models import SynonymGroup
from app.normalize import normalize_arabic
from app.schemas import SynonymGroupIn


def list_active(db: Session) -> list[SynonymGroup]:
    return list(
        db.scalars(
            select(SynonymGroup)
            .where(SynonymGroup.is_active.is_(True))
            .order_by(SynonymGroup.change_seq, SynonymGroup.id)
        )
    )


def _clean_terms(group: SynonymGroupIn) -> list[str]:
    seen: dict[str, None] = {}
    for term in group.terms:
        normalized = normalize_arabic(term)
        if normalized:
            seen.setdefault(normalized)
    terms = list(seen)
    if len(terms) < 2:
        raise ApiError(
            422, "VALIDATION_ERROR", "A synonym group needs at least two different words"
        )
    return terms


def replace_all(
    db: Session, groups: list[SynonymGroupIn], seq: int, device_id: uuid.UUID | None
) -> list[SynonymGroup]:
    cleaned = [(group, _clean_terms(group)) for group in groups]
    existing = {g.id: g for g in db.scalars(select(SynonymGroup))}
    kept: set[uuid.UUID] = set()
    now = clock.utcnow()
    for group, terms in cleaned:
        if group.id is not None and group.id not in existing:
            raise ApiError(404, "NOT_FOUND", "Synonym group not found")
        current = existing.get(group.id) if group.id is not None else None
        if current is None:
            created = SynonymGroup(
                id=uuid7(), terms=terms, is_active=True, updated_at=now, change_seq=seq
            )
            db.add(created)
            audit(
                db,
                "synonym_group",
                created.id,
                "create",
                after={"terms": terms},
                device_id=device_id,
            )
            kept.add(created.id)
            continue
        if current.id in kept:
            raise ApiError(422, "VALIDATION_ERROR", "The same group appears twice")
        kept.add(current.id)
        if current.terms != terms or not current.is_active:
            before = {"terms": current.terms, "is_active": current.is_active}
            current.terms = terms
            current.is_active = True
            current.updated_at = now
            current.change_seq = seq
            audit(
                db,
                "synonym_group",
                current.id,
                "update",
                before=before,
                after={"terms": terms, "is_active": True},
                device_id=device_id,
            )
    for group_id, current in existing.items():
        if group_id not in kept and current.is_active:
            audit(
                db,
                "synonym_group",
                current.id,
                "deactivate",
                before={"terms": current.terms, "is_active": True},
                after={"is_active": False},
                device_id=device_id,
            )
            current.is_active = False
            current.updated_at = now
            current.change_seq = seq
    db.flush()
    return list_active(db)

"""Synonym groups for search (SPEC section 12). Online only, like catalog editing."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.changeseq import take_seq
from app.db import get_db
from app.deps import AuthContext, current_auth
from app.schemas import SynonymGroupOut, SynonymsPut
from app.services import synonyms

router = APIRouter(prefix="/synonyms", tags=["synonyms"])


@router.get("", response_model=list[SynonymGroupOut])
def list_groups(
    db: Session = Depends(get_db), _auth: AuthContext = Depends(current_auth)
) -> list[SynonymGroupOut]:
    return [SynonymGroupOut.model_validate(g) for g in synonyms.list_active(db)]


@router.put("", response_model=list[SynonymGroupOut])
def replace_groups(
    body: SynonymsPut,
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(current_auth),
) -> list[SynonymGroupOut]:
    result = synonyms.replace_all(db, body.groups, take_seq(db), auth.device.id)
    db.commit()
    return [SynonymGroupOut.model_validate(g) for g in result]

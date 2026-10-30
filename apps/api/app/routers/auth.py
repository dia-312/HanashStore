import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app import clock
from app.config import get_settings
from app.db import get_db
from app.deps import (
    AuthContext,
    clear_session_cookie,
    client_ip,
    current_auth,
    get_limiter,
    set_session_cookie,
)
from app.errors import ApiError
from app.ids import uuid7
from app.models import AuthSession, Device, User
from app.ratelimit import LoginLimiter
from app.security import hash_secret, hash_token, new_session_token, verify_secret

router = APIRouter(prefix="/auth", tags=["auth"])

PIN = Annotated[str, StringConstraints(pattern=r"^[0-9]{4,6}$")]
# Verified against when no user exists, so a missing account takes as long as a wrong password.
_DUMMY_HASH_SECRET = "no-such-user"


class LoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    device_name: str = Field(default="iPad", min_length=1, max_length=80)
    # Sent by a device that already registered, so logging in again keeps the same device row.
    device_id: uuid.UUID | None = None
    # The rep confirmed that the previously active device may be revoked (SPEC F1).
    confirm_replace: bool = False


class UserOut(BaseModel):
    id: uuid.UUID
    name: str


class DeviceOut(BaseModel):
    id: uuid.UUID
    name: str


class MeOut(BaseModel):
    user: UserOut
    device: DeviceOut
    has_pin: bool


class PinIn(BaseModel):
    pin: PIN


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)


def _me(user: User, device: Device) -> MeOut:
    return MeOut(
        user=UserOut(id=user.id, name=user.name),
        device=DeviceOut(id=device.id, name=device.name),
        has_pin=user.pin_hash is not None,
    )


def _rate_limited(retry_after: int) -> ApiError:
    return ApiError(
        429,
        "RATE_LIMITED",
        "Too many attempts, try again later",
        {"retry_after": retry_after},
        {"Retry-After": str(retry_after)},
    )


@router.post("/login", response_model=MeOut)
def login(
    body: LoginIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    limiter: LoginLimiter = Depends(get_limiter),
) -> MeOut:
    key = client_ip(request)
    wait = limiter.retry_after(key)
    if wait:
        raise _rate_limited(wait)

    user = db.scalar(select(User).order_by(User.created_at).limit(1))
    stored = user.password_hash if user else hash_secret(_DUMMY_HASH_SECRET)
    if not verify_secret(stored, body.password) or user is None:
        limiter.record_failure(key)
        wait = limiter.retry_after(key)
        if wait:
            raise _rate_limited(wait)
        raise ApiError(401, "INVALID_CREDENTIALS", "Wrong password")
    limiter.reset(key)

    now = clock.utcnow()
    device = db.get(Device, body.device_id) if body.device_id else None
    if device is not None and device.revoked_at is not None:
        device = None  # a revoked device registers again as a new one
    active = select(Device).where(Device.revoked_at.is_(None))
    if device is not None:
        active = active.where(Device.id != device.id)
    others = db.scalars(active).all()
    if others and not body.confirm_replace:
        raise ApiError(
            409,
            "DEVICE_REPLACE_CONFIRM",
            "Another device is active; confirm to revoke it",
            {"active_device": {"name": others[0].name, "last_seen_at": others[0].last_seen_at}},
        )
    for other in others:
        other.revoked_at = now

    if device is None:
        device = Device(id=uuid7(), name=body.device_name, created_at=now)
        db.add(device)
    else:
        device.name = body.device_name
    device.last_seen_at = now
    # Without relationship() SQLAlchemy would not insert the device before the session.
    db.flush()

    token = new_session_token()
    db.add(
        AuthSession(
            id=uuid7(),
            token_hash=hash_token(token),
            user_id=user.id,
            device_id=device.id,
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(days=get_settings().session_days),
        )
    )
    db.commit()
    set_session_cookie(response, token)
    return _me(user, device)


@router.get("/me", response_model=MeOut)
def me(auth: AuthContext = Depends(current_auth)) -> MeOut:
    return _me(auth.user, auth.device)


@router.post("/logout", status_code=204)
def logout(
    response: Response, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> None:
    db.delete(auth.session)
    db.commit()
    clear_session_cookie(response)


@router.post("/logout-all", status_code=204)
def logout_all(
    response: Response, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> None:
    db.execute(delete(AuthSession).where(AuthSession.user_id == auth.user.id))
    db.commit()
    clear_session_cookie(response)


@router.put("/pin", status_code=204)
def set_pin(
    body: PinIn, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> None:
    auth.user.pin_hash = hash_secret(body.pin)
    db.commit()


@router.put("/password", status_code=204)
def change_password(
    body: PasswordIn,
    request: Request,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    limiter: LoginLimiter = Depends(get_limiter),
) -> None:
    key = f"password:{client_ip(request)}"
    wait = limiter.retry_after(key)
    if wait:
        raise _rate_limited(wait)
    if not verify_secret(auth.user.password_hash, body.current_password):
        limiter.record_failure(key)
        raise ApiError(401, "INVALID_CREDENTIALS", "Wrong current password")
    limiter.reset(key)
    auth.user.password_hash = hash_secret(body.new_password)
    db.commit()

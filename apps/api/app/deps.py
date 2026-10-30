from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import clock
from app.config import get_settings
from app.db import get_db
from app.errors import ApiError
from app.models import AuthSession, Device, User
from app.ratelimit import LoginLimiter
from app.security import hash_token

SESSION_COOKIE = "session"
# The sliding expiry is written at most once a minute instead of on every request.
_TOUCH_EVERY = timedelta(minutes=1)


@dataclass
class AuthContext:
    user: User
    device: Device
    session: AuthSession


def set_session_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=s.session_days * 86400,
        httponly=True,
        secure=s.cookie_secure,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def get_limiter(request: Request) -> LoginLimiter:
    limiter: LoginLimiter = request.app.state.login_limiter
    return limiter


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def current_auth(
    request: Request, response: Response, db: Session = Depends(get_db)
) -> AuthContext:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise ApiError(401, "UNAUTHENTICATED", "Login required")
    now = clock.utcnow()
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    if session is None or session.expires_at <= now:
        raise ApiError(401, "UNAUTHENTICATED", "Session expired, login again")
    device = db.get(Device, session.device_id)
    user = db.get(User, session.user_id)
    if device is None or user is None:
        raise ApiError(401, "UNAUTHENTICATED", "Login required")
    if device.revoked_at is not None:
        # The client wipes its local data when it sees this code (SPEC section 13).
        raise ApiError(401, "DEVICE_REVOKED", "This device was revoked")
    if now - session.last_seen_at >= _TOUCH_EVERY:
        session.last_seen_at = now
        session.expires_at = now + timedelta(days=get_settings().session_days)
        device.last_seen_at = now
        db.commit()
        set_session_cookie(response, token)
    return AuthContext(user=user, device=device, session=session)

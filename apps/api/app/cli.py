"""Management commands. There is no public sign-up: the one user is created here.

python -m app.cli create-user --name "Abu Mahmoud"      (password from ADMIN_PASSWORD or a prompt)
"""

import argparse
import getpass
import os
import sys

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.db import get_engine
from app.ids import uuid7
from app.models import User
from app.security import hash_secret

MIN_PASSWORD_LENGTH = 8


def create_user(session: Session, name: str, password: str) -> User:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
    if session.scalar(select(func.count()).select_from(User)):
        raise ValueError("A user already exists; this app has exactly one")
    user = User(
        id=uuid7(), name=name, password_hash=hash_secret(password), created_at=clock.utcnow()
    )
    session.add(user)
    session.commit()
    return user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create-user", help="create the one user of this installation")
    create.add_argument("--name", required=True)
    args = parser.parse_args(argv)

    if args.command == "create-user":
        password = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Password: ")
        try:
            with Session(get_engine()) as session:
                user = create_user(session, args.name, password)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(f"created user {user.name} ({user.id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

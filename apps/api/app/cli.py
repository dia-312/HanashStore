"""Management commands. There is no public sign-up: the one user is created here.

python -m app.cli create-user --name "Abu Mahmoud"      (password from ADMIN_PASSWORD or a prompt)
python -m app.cli recompute-stock [--fix]                (check the stock cache vs the movements)
"""

import argparse
import getpass
import os
import sys

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import clock
from app.changeseq import take_seq
from app.db import get_engine
from app.ids import uuid7
from app.models import ProductVariant, User
from app.security import hash_secret
from app.services.stock import stock_mismatches

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


def recompute_stock(fix: bool) -> int:
    """0 when the cache matches the movements (or was just fixed), 1 when it differs."""
    with Session(get_engine()) as session:
        mismatches = stock_mismatches(session)
        for variant_id, cached, actual in mismatches:
            print(f"variant {variant_id}: cache {cached}, movements {actual}")
        if not mismatches:
            print("stock cache matches the movements")
            return 0
        if not fix:
            return 1
        seq = take_seq(session)
        for variant_id, _, actual in mismatches:
            variant = session.get(ProductVariant, variant_id)
            if variant is not None:
                variant.stock_qty = actual
                variant.updated_at = clock.utcnow()
                variant.change_seq = seq
        session.commit()
        print(f"fixed {len(mismatches)} variant(s)")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create-user", help="create the one user of this installation")
    create.add_argument("--name", required=True)
    recompute = sub.add_parser(
        "recompute-stock", help="compare variants.stock_qty with the sum of their movements"
    )
    recompute.add_argument("--fix", action="store_true", help="write the sums into the cache")
    args = parser.parse_args(argv)

    if args.command == "create-user":
        password = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Password: ")
        try:
            with Session(get_engine()) as session:
                user = create_user(session, args.name, password)
                print(f"created user {user.name} ({user.id})")
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    elif args.command == "recompute-stock":
        return recompute_stock(fix=args.fix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

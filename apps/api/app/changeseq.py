"""change_seq for sync pull (SPEC sections 6 and 8).

One write transaction takes one number from the single `sync_clock` row. The UPDATE keeps the row
locked until commit, so writers queue up and numbers become visible in the order they were taken:
a device that pulls "everything after N" can never miss a row that commits later with a smaller N.
"""

from sqlalchemy import text
from sqlalchemy.orm import Session

_KEY = "change_seq_tx"


def take_seq(db: Session) -> int:
    """The transaction's change_seq: taken on the first call, reused by later calls in it."""
    tx = db.get_transaction() or db.begin()
    cached = db.info.get(_KEY)
    if cached is not None and cached[0] is tx:
        seq: int = cached[1]
        return seq
    seq = db.execute(
        text("UPDATE sync_clock SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq")
    ).scalar_one()
    db.info[_KEY] = (tx, seq)
    return seq

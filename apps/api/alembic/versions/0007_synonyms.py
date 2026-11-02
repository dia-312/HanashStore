"""synonym groups: words that mean the same thing for search, with the five seed groups

Revision ID: 0007
Revises: 0006
"""

import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

# SPEC section 9, already in normalized form.
SEED_GROUPS = [
    ["ارجيله", "اركيله", "شيشه", "نرجيله"],
    ["بربيش", "لي", "خرطوم"],
    ["فحم", "فحمات"],
    ["راس", "حجر"],
    ["ماسك", "مبسم"],
]


def upgrade() -> None:
    table = op.create_table(
        "synonym_groups",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("terms", ARRAY(sa.String()), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("change_seq", sa.BigInteger(), nullable=False),
    )
    op.create_index("ix_synonym_groups_change_seq", "synonym_groups", ["change_seq"])
    # One change_seq for the whole seed, so every device that already synced pulls the groups.
    seq = (
        op.get_bind()
        .execute(
            sa.text("UPDATE sync_clock SET last_seq = last_seq + 1 WHERE id = 1 RETURNING last_seq")
        )
        .scalar_one()
    )
    op.bulk_insert(
        table,
        [
            {
                "id": uuid.uuid4(),
                "terms": terms,
                "is_active": True,
                "updated_at": datetime.now(UTC),
                "change_seq": seq,
            }
            for terms in SEED_GROUPS
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_synonym_groups_change_seq", table_name="synonym_groups")
    op.drop_table("synonym_groups")

from datetime import UTC, datetime


def utcnow() -> datetime:
    """The one place the API reads the clock, so tests can move time."""
    return datetime.now(UTC)

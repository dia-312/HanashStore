import os
import time
import uuid


def uuid7(now_ms: int | None = None) -> uuid.UUID:
    """UUIDv7 (RFC 9562): 48-bit unix ms timestamp, then random bits. Sorts by creation time."""
    ms = now_ms if now_ms is not None else time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big") & ((1 << 74) - 1)
    rand_a, rand_b = rand >> 62, rand & ((1 << 62) - 1)
    value = ((ms & ((1 << 48) - 1)) << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return uuid.UUID(int=value)

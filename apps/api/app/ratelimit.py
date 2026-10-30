import time
from collections.abc import Callable


class LoginLimiter:
    """Per-key failed-attempt limiter: `max_attempts` failures within `window` seconds lock the key
    for `lockout` seconds (SPEC section 13: 5 per minute, then 15 minutes). Kept in memory, which is
    enough for the single API process this app runs."""

    def __init__(
        self,
        max_attempts: int = 5,
        window: float = 60.0,
        lockout: float = 900.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_attempts = max_attempts
        self.window = window
        self.lockout = lockout
        self._clock = clock
        self._failures: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}

    def retry_after(self, key: str) -> int:
        """Seconds until `key` may try again; 0 when it is not locked."""
        until = self._locked_until.get(key)
        if until is None:
            return 0
        remaining = until - self._clock()
        if remaining <= 0:
            del self._locked_until[key]
            return 0
        return int(remaining) + 1

    def record_failure(self, key: str) -> None:
        now = self._clock()
        recent = [t for t in self._failures.get(key, []) if now - t < self.window]
        recent.append(now)
        if len(recent) >= self.max_attempts:
            self._locked_until[key] = now + self.lockout
            recent = []
        self._failures[key] = recent

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)
        self._locked_until.pop(key, None)

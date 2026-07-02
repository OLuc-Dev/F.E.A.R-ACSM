from __future__ import annotations

import time
from collections import OrderedDict


class RateLimiter:
    """A fixed-window rate limiter keyed by an arbitrary string (e.g. client IP).

    In-memory and single-process — same scope as the rest of the runtime. The key
    map is LRU-bounded so a flood of distinct keys can't grow it without limit.
    """

    def __init__(
        self, limit: int = 10, window_seconds: float = 60.0, max_keys: int = 10_000
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._max_keys = max_keys
        # key -> (window_start, count)
        self._hits: OrderedDict[str, tuple[float, int]] = OrderedDict()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        """Record a hit for `key`; return True if it is within the limit."""
        current = time.monotonic() if now is None else now
        start, count = self._hits.get(key, (current, 0))
        if current - start >= self._window:
            start, count = current, 0  # window rolled over — start fresh
        count += 1
        self._hits[key] = (start, count)
        self._hits.move_to_end(key)
        while len(self._hits) > self._max_keys:
            self._hits.popitem(last=False)
        return count <= self._limit

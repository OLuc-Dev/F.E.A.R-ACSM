from __future__ import annotations

from fear.web.ratelimit import RateLimiter

# `now` is injected so the window behaviour is deterministic (no real clock).


def test_allows_up_to_limit_then_blocks() -> None:
    limiter = RateLimiter(limit=3, window_seconds=60.0)
    assert [limiter.allow("ip", now=0.0) for _ in range(3)] == [True, True, True]
    assert limiter.allow("ip", now=0.0) is False


def test_window_rolls_over() -> None:
    limiter = RateLimiter(limit=2, window_seconds=10.0)
    assert limiter.allow("ip", now=0.0) is True
    assert limiter.allow("ip", now=1.0) is True
    assert limiter.allow("ip", now=5.0) is False  # still inside the window
    assert limiter.allow("ip", now=11.0) is True  # window rolled over


def test_keys_are_independent() -> None:
    limiter = RateLimiter(limit=1, window_seconds=60.0)
    assert limiter.allow("a", now=0.0) is True
    assert limiter.allow("b", now=0.0) is True  # different key, own budget
    assert limiter.allow("a", now=0.0) is False

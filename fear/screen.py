"""What's on this computer's screen, as one picture for a model to look at.

Taken only when asked (a question with the screen shared, or the commentator's
glance), kept in memory for that one reply and never written anywhere.
"""

from __future__ import annotations

import importlib.util
import io

# Big enough to read text in a game or a page, small enough for a 4B model to
# look at in a few seconds.
MAX_SIDE = 1280


def screen_available() -> bool:
    return importlib.util.find_spec("mss") is not None


def capture_screen(max_side: int = MAX_SIDE) -> bytes:
    """The main monitor right now, as a JPEG no wider or taller than `max_side`."""
    import mss
    from PIL import Image

    with mss.mss() as shooter:
        shot = shooter.grab(shooter.monitors[1])  # [0] is every monitor together
    image = Image.frombytes("RGB", shot.size, shot.rgb)
    image.thumbnail((max_side, max_side))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=80)
    return buffer.getvalue()

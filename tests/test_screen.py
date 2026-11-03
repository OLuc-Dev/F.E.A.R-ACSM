"""Taking a picture of the screen, with a stand-in for mss (no display here)."""

from __future__ import annotations

import io
import sys
import types

from PIL import Image

from fear import screen


def test_the_screen_comes_out_as_a_small_jpeg(monkeypatch) -> None:
    width, height = 2560, 1440

    class Shooter:
        monitors = [{"all": True}, {"left": 0, "top": 0, "width": width, "height": height}]

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def grab(self, monitor):
            assert monitor is self.monitors[1]  # the main monitor, not all of them
            return types.SimpleNamespace(size=(width, height), rgb=b"\x10\x20\x30" * width * height)

    monkeypatch.setitem(sys.modules, "mss", types.SimpleNamespace(mss=Shooter))

    picture = Image.open(io.BytesIO(screen.capture_screen()))

    assert picture.format == "JPEG"
    assert picture.size == (1280, 720)  # the long side down to 1280, proportions kept

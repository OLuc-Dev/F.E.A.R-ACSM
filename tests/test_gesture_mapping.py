from __future__ import annotations

from fear.input.wearable_taps import WearableTapEvent, gesture_to_command


def test_single_tap() -> None:
    assert gesture_to_command(WearableTapEvent("single_tap")) == "toggle Spotify playback"


def test_double_tap() -> None:
    assert gesture_to_command(WearableTapEvent("double_tap")) == "next Spotify song"


def test_long_press() -> None:
    assert gesture_to_command(WearableTapEvent("long_press")) == "start voice command capture"


def test_double_clap() -> None:
    assert gesture_to_command(WearableTapEvent("double_clap")) == "toggle Spotify playback"

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


GestureName = Literal["single_tap", "double_tap", "long_press", "double_clap"]


@dataclass(slots=True)
class WearableTapEvent:
    """Normalized tap event coming from a wearable bridge."""

    gesture: GestureName
    device_id: Optional[str] = None


def gesture_to_command(event: WearableTapEvent) -> str:
    """Map simple gestures to assistant commands."""
    if event.gesture == "single_tap":
        return "toggle Spotify playback"

    if event.gesture == "double_tap":
        return "next Spotify song"

    if event.gesture == "long_press":
        return "start voice command capture"

    if event.gesture == "double_clap":
        return "toggle Spotify playback"

    return ""

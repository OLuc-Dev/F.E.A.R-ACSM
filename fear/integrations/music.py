"""Music commands: understood once, played through whichever backend works here.

The Spotify Web API needs a developer app, an OAuth login and Premium. The
system's media keys need none of that and drive whatever is playing — the
Spotify app, YouTube in a browser, VLC… — so the Windows app uses them unless
Spotify's API has been set up. Both read commands through ``music_intent``.
"""

from __future__ import annotations

import asyncio
import re
import sys
from collections.abc import Callable
from typing import Literal, Protocol

MusicIntent = Literal["toggle", "next", "previous", "pause", "resume"]

# \w, not [a-z]: an ASCII class split "próxima" into "pr" + "xima".
_WORD_RE = re.compile(r"\w+")

# Intent words, English and Brazilian Portuguese (F.E.A.R. is spoken to in both).
_TOGGLE = {"toggle", "alternar", "alterna"}
_NEXT = {"next", "skip", "próxima", "proxima", "pular", "pula", "avançar", "avança"}
_PREVIOUS = {"previous", "back", "anterior", "voltar", "volta"}
_PAUSE = {"pause", "stop", "pausar", "pausa", "parar"}
_RESUME = {"resume", "play", "tocar", "toca", "continuar", "continua", "retomar"}


def music_intent(text: str) -> MusicIntent | None:
    """The music command in `text`, or None.

    Whole words only: substring matching made "pause playback" hit "back" and
    skip to the previous track. Specific intents are checked before the greedy
    "play"/"resume" one, so "toggle Spotify playback" is not misread as resume.
    """
    words = set(_WORD_RE.findall(text.lower()))
    if words & _TOGGLE:
        return "toggle"
    if words & _NEXT:
        return "next"
    if words & _PREVIOUS:
        return "previous"
    if words & _PAUSE:
        return "pause"
    if words & _RESUME:
        return "resume"
    return None


class MusicPlayer(Protocol):
    """What the brain needs from a music backend."""

    @property
    def is_configured(self) -> bool: ...

    async def handle_intent(self, text: str) -> str: ...


# Virtual-key codes of the keyboard's media keys.
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_PLAY_PAUSE = 0xB3
_KEYEVENTF_EXTENDEDKEY = 0x1
_KEYEVENTF_KEYUP = 0x2


def _press_windows_media_key(key: int) -> None:
    import ctypes

    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    user32.keybd_event(key, 0, _KEYEVENTF_EXTENDEDKEY, 0)
    user32.keybd_event(key, 0, _KEYEVENTF_EXTENDEDKEY | _KEYEVENTF_KEYUP, 0)


class MediaKeys:
    """Presses the system media keys (Windows): no account, no setup, any player."""

    def __init__(self, press: Callable[[int], None] | None = None) -> None:
        if press is None and sys.platform == "win32":
            press = _press_windows_media_key
        self._press = press

    @property
    def is_configured(self) -> bool:
        return self._press is not None

    async def handle_intent(self, text: str) -> str:
        intent = music_intent(text)
        if intent is None or self._press is None:
            return ""
        if intent == "next":
            key, reply = VK_MEDIA_NEXT_TRACK, "Próxima faixa."
        elif intent == "previous":
            key, reply = VK_MEDIA_PREV_TRACK, "Faixa anterior."
        else:
            # The key only toggles, so "pause" and "play" both land here: it
            # cannot tell whether something is playing.
            key, reply = VK_MEDIA_PLAY_PAUSE, "Play/pause na música."
        await asyncio.to_thread(self._press, key)
        return reply


def choose_music_player(spotify: MusicPlayer, media_keys: MusicPlayer) -> MusicPlayer:
    """Spotify's API when it is set up, else the media keys when this OS has them."""
    if spotify.is_configured or not media_keys.is_configured:
        return spotify
    return media_keys

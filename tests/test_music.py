"""Music commands and the media-key player the Windows app uses by default."""

from __future__ import annotations

import asyncio

import pytest

from fear.integrations.music import (
    VK_MEDIA_NEXT_TRACK,
    VK_MEDIA_PLAY_PAUSE,
    VK_MEDIA_PREV_TRACK,
    MediaKeys,
    choose_music_player,
    music_intent,
)


@pytest.mark.parametrize(
    ("text", "intent"),
    [
        ("toggle Spotify playback", "toggle"),
        ("pausa a música", "pause"),
        ("próxima música", "next"),
        ("volta a música anterior", "previous"),
        ("toca uma música", "resume"),
        ("pause playback", "pause"),  # "playback" contains "back": whole words only
        ("qual música você recomenda?", None),
    ],
)
def test_music_intent(text: str, intent: str | None) -> None:
    assert music_intent(text) == intent


def _keys() -> tuple[MediaKeys, list[int]]:
    pressed: list[int] = []
    return MediaKeys(press=pressed.append), pressed


def test_media_keys_press_the_matching_key() -> None:
    keys, pressed = _keys()
    replies = [
        asyncio.run(keys.handle_intent(text))
        for text in ("next Spotify song", "previous Spotify song", "toggle Spotify playback")
    ]
    assert pressed == [VK_MEDIA_NEXT_TRACK, VK_MEDIA_PREV_TRACK, VK_MEDIA_PLAY_PAUSE]
    assert replies == ["Próxima faixa.", "Faixa anterior.", "Play/pause na música."]


def test_pause_and_play_both_use_the_play_pause_key() -> None:
    keys, pressed = _keys()
    asyncio.run(keys.handle_intent("pausa a música"))
    asyncio.run(keys.handle_intent("toca a música"))
    assert pressed == [VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PLAY_PAUSE]


def test_media_keys_ignore_what_is_not_a_music_command() -> None:
    keys, pressed = _keys()
    assert asyncio.run(keys.handle_intent("qual música você recomenda?")) == ""
    assert pressed == []


class _Player:
    def __init__(self, configured: bool) -> None:
        self.is_configured = configured

    async def handle_intent(self, text: str) -> str:
        return ""


def test_spotify_wins_when_its_api_is_set_up() -> None:
    spotify, keys = _Player(True), _Player(True)
    assert choose_music_player(spotify, keys) is spotify


def test_media_keys_stand_in_for_an_unconfigured_spotify() -> None:
    spotify, keys = _Player(False), _Player(True)
    assert choose_music_player(spotify, keys) is keys


def test_without_media_keys_spotify_answers_for_itself() -> None:
    # Off Windows there are no media keys; the unconfigured Spotify then says so
    # instead of the model pretending it paused the music.
    spotify, keys = _Player(False), _Player(False)
    assert choose_music_player(spotify, keys) is spotify

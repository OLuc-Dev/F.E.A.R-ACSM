from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any, Optional

import spotipy
from spotipy.oauth2 import SpotifyOAuth


@dataclass(slots=True)
class SpotifyStatus:
    """Compact representation of Spotify playback state."""

    is_configured: bool
    is_playing: bool = False
    track_name: Optional[str] = None
    artist_name: Optional[str] = None
    device_name: Optional[str] = None


class SpotifyClient:
    """Async-friendly wrapper around Spotipy playback controls."""

    def __init__(self, *, scope: str) -> None:
        self.scope = scope
        self._client: Optional[spotipy.Spotify] = None

    @property
    def is_configured(self) -> bool:
        """Return True when Spotify credentials are available and client exists."""
        return self._client is not None

    async def load(self) -> None:
        """Initialize Spotipy if credentials are present in the environment."""
        if self._client is not None:
            return

        if not os.getenv("SPOTIPY_CLIENT_ID") or not os.getenv("SPOTIPY_CLIENT_SECRET"):
            return

        self._client = await asyncio.to_thread(
            lambda: spotipy.Spotify(auth_manager=SpotifyOAuth(scope=self.scope))
        )

    async def status(self) -> SpotifyStatus:
        """Return current playback status."""
        if self._client is None:
            return SpotifyStatus(is_configured=False)

        playback = await asyncio.to_thread(self._client.current_playback)

        if not playback:
            return SpotifyStatus(is_configured=True)

        item: dict[str, Any] = playback.get("item") or {}
        artists = item.get("artists") or []
        device = playback.get("device") or {}

        return SpotifyStatus(
            is_configured=True,
            is_playing=bool(playback.get("is_playing")),
            track_name=item.get("name"),
            artist_name=artists[0].get("name") if artists else None,
            device_name=device.get("name"),
        )

    async def pause(self) -> str:
        """Pause playback."""
        if self._client is None:
            return "Spotify is not configured."

        await asyncio.to_thread(self._client.pause_playback)
        return "Paused Spotify."

    async def resume(self) -> str:
        """Resume playback."""
        if self._client is None:
            return "Spotify is not configured."

        await asyncio.to_thread(self._client.start_playback)
        return "Resumed Spotify."

    async def next_track(self) -> str:
        """Skip to the next track."""
        if self._client is None:
            return "Spotify is not configured."

        await asyncio.to_thread(self._client.next_track)
        return "Skipped to the next track."

    async def previous_track(self) -> str:
        """Return to the previous track."""
        if self._client is None:
            return "Spotify is not configured."

        await asyncio.to_thread(self._client.previous_track)
        return "Went back to the previous track."

    async def toggle(self) -> str:
        """Pause when playing, otherwise resume."""
        status = await self.status()

        if not status.is_configured:
            return "Spotify is not configured."

        if status.is_playing:
            return await self.pause()

        return await self.resume()

    async def handle_intent(self, text: str) -> str:
        """Handle simple natural-language Spotify commands."""
        lower = text.lower()

        if "pause" in lower:
            return await self.pause()
        if "resume" in lower or "play" in lower:
            return await self.resume()
        if "next" in lower or "skip" in lower:
            return await self.next_track()
        if "previous" in lower or "back" in lower:
            return await self.previous_track()
        if "toggle" in lower:
            return await self.toggle()

        return ""

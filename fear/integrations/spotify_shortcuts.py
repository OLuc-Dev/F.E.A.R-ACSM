from __future__ import annotations

from typing import Optional

from fear.integrations.spotify_client import SpotifyClient


async def play_spotify_track(
    spotify: SpotifyClient,
    track_name: str,
    artist: Optional[str] = None,
) -> str:
    """
    Search a Spotify track and start playback on the active device.

    The underlying SpotifyClient must already be loaded and authenticated.
    """
    client = spotify._client

    if client is None:
        return "Spotify is not configured."

    query = f"track:{track_name}"
    if artist:
        query += f" artist:{artist}"

    result = await spotify_async_call(client.search, q=query, type="track", limit=1)
    tracks = ((result or {}).get("tracks") or {}).get("items") or []

    if not tracks:
        return f"I could not find {track_name} on Spotify."

    uri = tracks[0]["uri"]
    name = tracks[0].get("name", track_name)
    artists = tracks[0].get("artists") or []
    artist_name = artists[0].get("name") if artists else artist or "unknown artist"

    await spotify_async_call(client.start_playback, uris=[uri])
    return f"Playing {name} by {artist_name}."


async def handle_spotify_shortcut(shortcut: str, spotify: SpotifyClient) -> str:
    """Map wearable shortcuts to Spotify actions."""
    if shortcut == "double_tap":
        return await play_spotify_track(spotify, "God's Plan", artist="Drake")

    if shortcut == "single_tap":
        return await spotify.toggle()

    if shortcut == "long_press":
        return await spotify.next_track()

    return "Unknown Spotify shortcut."


async def spotify_async_call(func, *args, **kwargs):
    """Run a blocking Spotipy call in a worker thread."""
    import asyncio

    return await asyncio.to_thread(func, *args, **kwargs)

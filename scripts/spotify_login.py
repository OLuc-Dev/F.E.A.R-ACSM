"""One-time Spotify authorization for F.E.A.R.

Prerequisites (in your local .env, never committed):
  SPOTIPY_CLIENT_ID, SPOTIPY_CLIENT_SECRET, SPOTIPY_REDIRECT_URI

The redirect URI must also be registered in your Spotify app settings
(https://developer.spotify.com/dashboard). Run this once:

    python scripts/spotify_login.py

It opens a browser to authorize, then spotipy caches the token locally so the
assistant can control playback. You do not need to share any credentials.
"""

from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

from fear.config import Settings


def main() -> int:
    load_dotenv()

    missing = [
        name
        for name in ("SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI")
        if not os.getenv(name)
    ]
    if missing:
        print(f"Missing in your environment/.env: {', '.join(missing)}")
        print("Fill them in (see .env.example) and try again.")
        return 1

    # Imported here so the script gives a clean error if spotipy is not installed.
    import spotipy
    from spotipy.oauth2 import SpotifyOAuth

    settings = Settings.from_env()
    client = spotipy.Spotify(auth_manager=SpotifyOAuth(scope=settings.spotify_scope))

    me = client.current_user()
    name = me.get("display_name") or me.get("id", "unknown")
    print(f"Authorized as {name}. Token cached — F.E.A.R. can now control Spotify.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

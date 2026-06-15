from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any

import pyttsx3
import requests  # type: ignore[import-untyped]


class NaturalTTS:
    """Text-to-speech with remote natural voice support and offline fallback."""

    def __init__(self, *, timeout_seconds: float = 30.0) -> None:
        self.timeout_seconds = timeout_seconds
        self.remote_api_key = os.getenv("ELEVENLABS_API_KEY", "")
        self.default_voice = os.getenv("ELEVENLABS_DEFAULT_VOICE_ID", "")
        self.remote_model = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
        self._offline_engine: Any = None
        self._lock = asyncio.Lock()

    async def say(self, text: str, voice: str = "default") -> Path | None:
        """Speak text. Returns an audio file path when remote synthesis is used."""
        if not text.strip():
            return None

        async with self._lock:
            if self.remote_api_key and (voice != "default" or self.default_voice):
                return await asyncio.to_thread(self._synthesize_remote, text, voice)

            await asyncio.to_thread(self._speak_offline, text)
            return None

    def _synthesize_remote(self, text: str, voice: str) -> Path:
        """Create speech audio with the configured remote provider."""
        voice_id = self.default_voice if voice == "default" else voice
        if not voice_id:
            raise ValueError("A remote voice id is required")

        endpoint = "https://api.elevenlabs.io/v1/text-to-speech/" + voice_id
        response = requests.post(
            endpoint,
            headers={
                "accept": "audio/mpeg",
                "content-type": "application/json",
                "xi-api-key": self.remote_api_key,
            },
            json={
                "text": text,
                "model_id": self.remote_model,
                "voice_settings": {
                    "stability": 0.45,
                    "similarity_boost": 0.75,
                },
            },
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()

        _, raw_path = tempfile.mkstemp(prefix="fear_tts_", suffix=".mp3")
        output_path = Path(raw_path)
        output_path.write_bytes(response.content)
        return output_path

    def _speak_offline(self, text: str) -> None:
        """Speak locally with pyttsx3."""
        if self._offline_engine is None:
            self._offline_engine = pyttsx3.init()

        self._offline_engine.say(text)
        self._offline_engine.runAndWait()

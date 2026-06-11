from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

import whisper


class WhisperSpeechToText:
    """Async-friendly wrapper around local OpenAI Whisper models."""

    def __init__(self, model_name: str = "base") -> None:
        self.model_name = model_name
        self._model: Optional[Any] = None

    async def load(self) -> None:
        """Load the Whisper model in a worker thread."""
        if self._model is not None:
            return

        self._model = await asyncio.to_thread(whisper.load_model, self.model_name)

    async def transcribe(self, audio_path: Path, *, delete_after: bool = True) -> str:
        """
        Transcribe an audio file and return stripped text.

        Args:
            audio_path: Path to a WAV/MP3/etc. file accepted by Whisper.
            delete_after: Delete the temporary file after transcription.
        """
        if self._model is None:
            await self.load()

        try:
            result = await asyncio.to_thread(self._model.transcribe, str(audio_path))
            return str(result.get("text", "")).strip()
        finally:
            if delete_after:
                try:
                    audio_path.unlink(missing_ok=True)
                except Exception:
                    pass

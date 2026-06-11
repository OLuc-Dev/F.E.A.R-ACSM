from __future__ import annotations

import asyncio
from typing import Any, Optional

import pyttsx3


class TextToSpeech:
    """Async-friendly wrapper around pyttsx3."""

    def __init__(self) -> None:
        self._engine: Optional[Any] = None
        self._lock = asyncio.Lock()

    async def load(self) -> None:
        """Initialize the pyttsx3 engine in a worker thread."""
        if self._engine is not None:
            return

        self._engine = await asyncio.to_thread(pyttsx3.init)

    async def say(self, text: str) -> None:
        """Speak text without blocking the asyncio event loop."""
        if not text:
            return

        if self._engine is None:
            await self.load()

        async with self._lock:
            await asyncio.to_thread(self._say_blocking, text)

    def _say_blocking(self, text: str) -> None:
        if self._engine is None:
            return

        self._engine.say(text)
        self._engine.runAndWait()

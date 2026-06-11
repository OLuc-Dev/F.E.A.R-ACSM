from __future__ import annotations

from typing import Iterable


def normalize_transcript(text: str) -> str:
    """Normalize transcribed text before wake-word matching."""
    return " ".join(text.lower().strip().split())


class WakeWordMatcher:
    """Simple text-based wake-word matcher for transcribed audio windows."""

    def __init__(self, wake_words: Iterable[str]) -> None:
        self.wake_words = tuple(normalize_transcript(word) for word in wake_words if word)

    def is_wake_word_present(self, transcript: str) -> bool:
        """Return True when any configured wake word appears in the transcript."""
        normalized = normalize_transcript(transcript)
        return any(wake_word in normalized for wake_word in self.wake_words)

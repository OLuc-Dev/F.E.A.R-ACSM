from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Tuple

from dotenv import load_dotenv


@dataclass(slots=True)
class Settings:
    """Runtime configuration for the F.E.A.R. desktop assistant."""

    assistant_name: str = "F.E.A.R."

    host: str = "127.0.0.1"
    port: int = 8765

    sample_rate: int = 16_000
    chunk_size: int = 1_024

    wake_words: Tuple[str, ...] = ("fear", "hey fear")
    whisper_model_name: str = "base"

    chroma_path: str = "data/chroma"
    chroma_collection_name: str = "fear_memory"

    # OpenRouter is used through an OpenAI-compatible client interface.
    # This does not require using OpenAI as the model provider.
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_chat_model: str = ""
    openrouter_embedding_model: str = ""
    openrouter_http_referer: str = "http://127.0.0.1:8765"
    openrouter_app_title: str = "F.E.A.R."

    clap_threshold: float = 0.1

    spotify_scope: str = (
        "user-read-playback-state "
        "user-modify-playback-state "
        "user-read-currently-playing"
    )

    @classmethod
    def from_env(cls) -> "Settings":
        """Load settings from .env and environment variables."""
        load_dotenv()

        return cls(
            assistant_name=os.getenv("FEAR_ASSISTANT_NAME", "F.E.A.R."),
            host=os.getenv("FEAR_HOST", "127.0.0.1"),
            port=int(os.getenv("FEAR_PORT", "8765")),
            sample_rate=int(os.getenv("FEAR_SAMPLE_RATE", "16000")),
            chunk_size=int(os.getenv("FEAR_CHUNK_SIZE", "1024")),
            wake_words=_parse_csv_env("FEAR_WAKE_WORDS", ("fear", "hey fear")),
            whisper_model_name=os.getenv("WHISPER_MODEL", "base"),
            chroma_path=os.getenv("CHROMA_PATH", "data/chroma"),
            chroma_collection_name=os.getenv("CHROMA_COLLECTION", "fear_memory"),
            openrouter_api_key=os.getenv("OPENROUTER_API_KEY", ""),
            openrouter_base_url=os.getenv(
                "OPENROUTER_BASE_URL",
                "https://openrouter.ai/api/v1",
            ),
            openrouter_chat_model=os.getenv("OPENROUTER_CHAT_MODEL", ""),
            openrouter_embedding_model=os.getenv("OPENROUTER_EMBEDDING_MODEL", ""),
            openrouter_http_referer=os.getenv(
                "OPENROUTER_HTTP_REFERER",
                "http://127.0.0.1:8765",
            ),
            openrouter_app_title=os.getenv("OPENROUTER_APP_TITLE", "F.E.A.R."),
            clap_threshold=float(os.getenv("CLAP_THRESHOLD", "0.1")),
        )


def _parse_csv_env(name: str, default: Tuple[str, ...]) -> Tuple[str, ...]:
    """Parse a comma-separated env var into a tuple of non-empty strings."""
    raw = os.getenv(name)

    if not raw:
        return default

    values = tuple(item.strip().lower() for item in raw.split(",") if item.strip())
    return values or default

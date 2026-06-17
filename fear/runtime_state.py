from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Non-secret runtime choices the settings panel can change live (chat model,
# persona mode). Persisted next to the local data so they survive a restart,
# layered on top of the .env defaults. Secrets never go here.


def _state_path(chroma_path: str) -> Path:
    """Place the state file beside the local data directory (e.g. data/)."""
    return Path(chroma_path).expanduser().parent / "runtime_config.json"


def load_runtime_config(chroma_path: str) -> dict[str, Any]:
    """Return persisted runtime choices, or an empty dict if none/unreadable."""
    try:
        data = json.loads(_state_path(chroma_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_runtime_config(chroma_path: str, *, model: str, persona_mode: str) -> None:
    """Persist runtime choices; a write failure is logged, never raised."""
    path = _state_path(chroma_path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {"model": model, "persona_mode": persona_mode}, ensure_ascii=False, indent=2
            ),
            encoding="utf-8",
        )
    except OSError:
        logger.warning("Could not persist runtime config to %s", path, exc_info=True)

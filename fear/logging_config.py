from __future__ import annotations

import logging
import os

_configured = False


def configure_logging() -> None:
    """Configure root logging once, honoring FEAR_LOG_LEVEL (default INFO).

    Idempotent: safe to call from both the server entrypoint and the app
    lifespan without installing duplicate handlers.
    """
    global _configured
    if _configured:
        return

    level_name = os.getenv("FEAR_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    _configured = True

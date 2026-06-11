from __future__ import annotations

import asyncio
import signal

from fear.assistant import FearAssistant
from fear.config import Settings


async def main() -> None:
    """Entrypoint for the F.E.A.R. desktop assistant."""
    settings = Settings.from_env()
    assistant = FearAssistant(settings)

    loop = asyncio.get_running_loop()

    # SIGTERM may not be supported by every Windows event loop policy, so this
    # is intentionally wrapped.
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, assistant.shutdown_event.set)
        except NotImplementedError:
            pass

    await assistant.start()


if __name__ == "__main__":
    asyncio.run(main())

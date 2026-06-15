from __future__ import annotations

from fear.web.app import run


def main() -> None:
    """Launch the local F.E.A.R. runtime.

    F.E.A.R. is a quiet local presence: it serves the web/command API and, when
    enabled via environment flags, listens for voice, claps, and Obsidian notes.
    """
    run()


if __name__ == "__main__":
    main()

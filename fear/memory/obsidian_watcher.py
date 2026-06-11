from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Iterable, Optional

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from fear.memory.personal_memory import PersonalMemory


FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


class ObsidianMarkdownHandler(FileSystemEventHandler):
    """Watchdog handler that indexes new or modified Markdown files."""

    def __init__(
        self,
        *,
        memory: PersonalMemory,
        speaker: str = "fear_user",
        source: str = "obsidian",
        debounce_seconds: float = 1.0,
    ) -> None:
        self.memory = memory
        self.speaker = speaker
        self.source = source
        self.debounce_seconds = debounce_seconds
        self._last_indexed_at: dict[Path, float] = {}
        self._logger = logging.getLogger(self.__class__.__name__)

    def on_created(self, event: FileSystemEvent) -> None:
        self._handle_event(event)

    def on_modified(self, event: FileSystemEvent) -> None:
        self._handle_event(event)

    def _handle_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return

        path = Path(str(event.src_path))
        if path.suffix.lower() != ".md":
            return

        now = time.time()
        last_indexed_at = self._last_indexed_at.get(path, 0.0)
        if now - last_indexed_at < self.debounce_seconds:
            return

        self._last_indexed_at[path] = now

        try:
            self.index_markdown_file(path)
        except Exception:
            self._logger.exception("Failed to index Obsidian file: %s", path)

    def index_markdown_file(self, path: Path) -> None:
        """Read a Markdown file, split it into paragraphs, and store each paragraph."""
        raw_text = path.read_text(encoding="utf-8", errors="ignore")
        content = strip_yaml_frontmatter(raw_text)

        for paragraph in split_markdown_paragraphs(content):
            self.memory.add_memory(
                paragraph,
                speaker=self.speaker,
                source=self.source,
            )


def strip_yaml_frontmatter(text: str) -> str:
    """Remove YAML frontmatter from a Markdown document."""
    return FRONTMATTER_RE.sub("", text, count=1).strip()


def split_markdown_paragraphs(text: str, *, min_chars: int = 20) -> list[str]:
    """Split Markdown text into indexable paragraphs."""
    paragraphs: list[str] = []

    for block in re.split(r"\n\s*\n", text):
        clean = " ".join(line.strip() for line in block.splitlines()).strip()

        if len(clean) < min_chars:
            continue

        paragraphs.append(clean)

    return paragraphs


class ObsidianWatcher:
    """Background thread wrapper around watchdog's Observer."""

    def __init__(
        self,
        *,
        vault_path: str | Path,
        memory: PersonalMemory,
        speaker: str = "fear_user",
        source: str = "obsidian",
    ) -> None:
        self.vault_path = Path(vault_path).expanduser().resolve()
        self.memory = memory
        self.speaker = speaker
        self.source = source
        self._observer: Optional[Observer] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._logger = logging.getLogger(self.__class__.__name__)

    def start(self) -> None:
        """Start watching the Obsidian vault in a background thread."""
        if self._thread and self._thread.is_alive():
            return

        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="ObsidianWatcherThread",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """Stop the watcher."""
        self._stop_event.set()

        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=timeout)
            self._observer = None

        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=timeout)

        self._thread = None

    def index_existing_files(self) -> None:
        """Index existing Markdown files once before live watching."""
        if not self.vault_path.exists():
            self._logger.warning("Obsidian vault does not exist: %s", self.vault_path)
            return

        handler = ObsidianMarkdownHandler(
            memory=self.memory,
            speaker=self.speaker,
            source=self.source,
        )

        for path in iter_markdown_files(self.vault_path):
            try:
                handler.index_markdown_file(path)
            except Exception:
                self._logger.exception("Failed to index existing file: %s", path)

    def _run(self) -> None:
        if not self.vault_path.exists():
            self._logger.warning("Obsidian vault does not exist: %s", self.vault_path)
            return

        handler = ObsidianMarkdownHandler(
            memory=self.memory,
            speaker=self.speaker,
            source=self.source,
        )

        observer = Observer()
        observer.schedule(handler, str(self.vault_path), recursive=True)
        observer.start()
        self._observer = observer

        try:
            while not self._stop_event.wait(timeout=0.25):
                pass
        finally:
            observer.stop()
            observer.join(timeout=2.0)


def iter_markdown_files(root: Path) -> Iterable[Path]:
    """Yield Markdown files inside a vault, skipping hidden folders."""
    for path in root.rglob("*.md"):
        if any(part.startswith(".") for part in path.parts):
            continue
        yield path

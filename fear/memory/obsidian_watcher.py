from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections.abc import Callable, Iterable
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

# `Observer` is a runtime alias for the platform's observer (inotify, FSEvents,
# …), i.e. a variable — not usable as an annotation. `BaseObserver` is their
# common base class and is what the attribute should be typed as.
from watchdog.observers.api import BaseObserver

from fear.memory.personal_memory import PersonalMemory

FRONTMATTER_RE = re.compile(r"^---\s*\n.*?\n---\s*\n", re.DOTALL)


def _no_owner() -> str:
    return ""


class ObsidianMarkdownHandler(FileSystemEventHandler):
    """Watchdog handler that indexes new or modified Markdown files."""

    def __init__(
        self,
        *,
        memory: PersonalMemory,
        speaker: str = "fear_user",
        source: str = "obsidian",
        debounce_seconds: float = 1.0,
        user_id: Callable[[], str] = _no_owner,
        vault_root: Path | None = None,
    ) -> None:
        self.memory = memory
        self.speaker = speaker
        self.source = source
        self.debounce_seconds = debounce_seconds
        # Resolved per note, so notes indexed after the owner signs up are theirs.
        self.user_id = user_id
        self.vault_root = vault_root
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
        if path.suffix.lower() != ".md" or self._is_hidden(path):
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

    def _is_hidden(self, path: Path) -> bool:
        """Skip .trash, .obsidian and other dot-folders, as the initial walk does."""
        if self.vault_root is None:
            return False
        try:
            relative = path.resolve().relative_to(self.vault_root)
        except ValueError:
            return False
        return any(part.startswith(".") for part in relative.parts)

    def index_markdown_file(self, path: Path) -> None:
        """Read a Markdown file, split it into paragraphs, and store each paragraph."""
        raw_text = path.read_text(encoding="utf-8", errors="ignore")
        content = strip_yaml_frontmatter(raw_text)
        owner_id = self.user_id()

        for paragraph in split_markdown_paragraphs(content):
            self.memory.add_memory(
                paragraph,
                speaker=self.speaker,
                source=self.source,
                user_id=owner_id,
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
        user_id: Callable[[], str] = _no_owner,
        state_file: str | Path | None = None,
    ) -> None:
        self.vault_path = Path(vault_path).expanduser().resolve()
        self.memory = memory
        self.speaker = speaker
        self.source = source
        self.user_id = user_id
        # Remembers when each vault was last scanned, so a restart only reads
        # the notes written in the meantime instead of embedding the vault again.
        self.state_file = Path(state_file) if state_file is not None else None
        self._observer: BaseObserver | None = None
        self._thread: threading.Thread | None = None
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

    def catch_up(self) -> int:
        """Index the notes written since the last scan: the whole vault the first time.

        Live watching only sees changes made while F.E.A.R. runs; without this,
        the notes that already existed (or were edited while it was closed) would
        never reach its memory. Returns how many files were indexed.
        """
        if not self.vault_path.exists():
            self._logger.warning("Obsidian vault does not exist: %s", self.vault_path)
            return 0
        state = self._load_state()
        since = float(state.get(str(self.vault_path), 0.0))
        started = time.time()
        handler = self._handler()
        indexed = 0
        for path in iter_markdown_files(self.vault_path):
            if self._stop_event.is_set():
                return indexed  # interrupted: don't record a scan that didn't finish
            try:
                if path.stat().st_mtime <= since:
                    continue
                handler.index_markdown_file(path)
                indexed += 1
            except Exception:
                self._logger.exception("Failed to index existing file: %s", path)
        state[str(self.vault_path)] = started
        self._save_state(state)
        return indexed

    def _load_state(self) -> dict[str, float]:
        if self.state_file is None:
            return {}
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_state(self, state: dict[str, float]) -> None:
        if self.state_file is None:
            return
        try:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(json.dumps(state), encoding="utf-8")
        except OSError:
            self._logger.warning("Could not record the Obsidian scan", exc_info=True)

    def _handler(self) -> ObsidianMarkdownHandler:
        return ObsidianMarkdownHandler(
            memory=self.memory,
            speaker=self.speaker,
            source=self.source,
            user_id=self.user_id,
            vault_root=self.vault_path,
        )

    def _run(self) -> None:
        if not self.vault_path.exists():
            self._logger.warning("Obsidian vault does not exist: %s", self.vault_path)
            return

        handler = self._handler()

        observer = Observer()
        observer.schedule(handler, str(self.vault_path), recursive=True)
        observer.start()
        self._observer = observer

        try:
            # Watching first, so notes saved while the catch-up runs aren't missed.
            indexed = self.catch_up()
            if indexed:
                self._logger.info("Indexed %d Obsidian note(s) written while away", indexed)
            while not self._stop_event.wait(timeout=0.25):
                pass
        finally:
            observer.stop()
            observer.join(timeout=2.0)


def iter_markdown_files(root: Path) -> Iterable[Path]:
    """Yield Markdown files inside a vault, skipping hidden folders.

    Only the path *below* the vault is inspected: `root` is resolved to an
    absolute path, so testing every part would skip the whole vault whenever it
    lives under a dot-directory (``~/.notes/vault``, a synced folder, …).
    """
    for path in root.rglob("*.md"):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        yield path

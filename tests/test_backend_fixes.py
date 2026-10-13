"""Regression tests for the backend bug sweep.

Each test here pins one concrete defect that was reachable in production: a
wrong Spotify action, a boot-time crash, a lost note, a world-readable token, or
an unindexable vault. They exercise the real functions — the only stand-ins are
for the third-party services themselves.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time
import types
from pathlib import Path

import pytest

from fear.config import Settings

# spotipy / watchdog are optional runtime extras (not installed in CI), so the
# tests that need them skip gracefully — the same guard test_chroma_integration
# uses for chromadb.


def _spotify_client_class() -> type:
    pytest.importorskip("spotipy")
    from fear.integrations.spotify_client import SpotifyClient

    return SpotifyClient


def _iter_markdown_files():
    pytest.importorskip("watchdog")
    from fear.memory.obsidian_watcher import iter_markdown_files

    return iter_markdown_files


# --- Spotify intent matching -------------------------------------------------


class _RecordingSpotify:
    """A SpotifyClient stand-in that records which action an intent chose."""

    def __init__(self) -> None:
        self.actions: list[str] = []

    async def toggle(self) -> str:
        self.actions.append("toggle")
        return "toggled"

    async def next_track(self) -> str:
        self.actions.append("next")
        return "next"

    async def previous_track(self) -> str:
        self.actions.append("previous")
        return "previous"

    async def pause(self) -> str:
        self.actions.append("pause")
        return "paused"

    async def resume(self) -> str:
        self.actions.append("resume")
        return "resumed"


def _intent(text: str) -> str:
    """Run the real handle_intent against a recorder and return the action."""
    spotify_client = _spotify_client_class()
    recorder = _RecordingSpotify()
    asyncio.run(spotify_client.handle_intent(recorder, text))  # type: ignore[arg-type]
    return recorder.actions[0] if recorder.actions else ""


@pytest.mark.parametrize(
    ("phrase", "expected"),
    [
        # The bug: "playback" contains "back", so these skipped to the previous
        # track instead of pausing/resuming.
        ("pause playback", "pause"),
        ("stop playback", "pause"),
        ("resume playback", "resume"),
        ("toggle Spotify playback", "toggle"),
        # The intents that must keep working.
        ("go back", "previous"),
        ("previous song", "previous"),
        ("next track", "next"),
        ("skip this song", "next"),
        ("play music", "resume"),
        # Portuguese commands used to fall through to the model, which could
        # claim it paused the music without touching Spotify.
        ("pausa a música", "pause"),
        ("próxima música", "next"),
        ("volta a música anterior", "previous"),
        ("toca uma música", "resume"),
    ],
)
def test_spotify_intents_match_whole_words(phrase: str, expected: str) -> None:
    assert _intent(phrase) == expected


def test_spotify_load_stays_inert_without_a_redirect_uri(monkeypatch) -> None:
    # SpotifyOAuth needs three env vars; a partial setup used to raise straight
    # out of the FastAPI lifespan and stop the whole backend from booting.
    spotify_client = _spotify_client_class()

    monkeypatch.setenv("SPOTIPY_CLIENT_ID", "id")
    monkeypatch.setenv("SPOTIPY_CLIENT_SECRET", "secret")
    monkeypatch.delenv("SPOTIPY_REDIRECT_URI", raising=False)

    client = spotify_client(scope="user-read-playback-state")
    asyncio.run(client.load())  # must not raise

    assert client.is_configured is False


def test_spotify_load_survives_a_failing_constructor(monkeypatch) -> None:
    _spotify_client_class()
    from fear.integrations import spotify_client as module

    for name in ("SPOTIPY_CLIENT_ID", "SPOTIPY_CLIENT_SECRET", "SPOTIPY_REDIRECT_URI"):
        monkeypatch.setenv(name, "x")

    def explode(*_args, **_kwargs):
        raise RuntimeError("spotipy refused")

    monkeypatch.setattr(module, "SpotifyOAuth", explode)

    client = module.SpotifyClient(scope="user-read-playback-state")
    asyncio.run(client.load())  # must not raise

    assert client.is_configured is False


# --- production guard --------------------------------------------------------


@pytest.mark.parametrize("env", ["production", "PRODUCTION", "prod", "Production-EU", " prod "])
def test_production_like_envs_are_treated_as_production(env: str) -> None:
    # is_production gates the fatal missing-FEAR_SECRET_KEY check. An exact
    # "production" match let FEAR_ENV=prod boot with an ephemeral secret, which
    # silently invalidates every session and stored API key on restart.
    assert Settings(env=env).is_production is True


@pytest.mark.parametrize("env", ["local", "development", "test", "staging", ""])
def test_non_production_envs_stay_permissive(env: str) -> None:
    assert Settings(env=env).is_production is False


def test_missing_secret_is_fatal_for_prod_spelling() -> None:
    from fear.web.app import resolve_secret_key

    with pytest.raises(RuntimeError):
        resolve_secret_key(Settings(env="prod", secret_key=""))


# --- OAuth token permissions -------------------------------------------------


def test_oauth_token_is_written_owner_only(tmp_path: Path) -> None:
    from fear.integrations.google_calendar import write_token_securely

    token_path = tmp_path / "nested" / "google_token.json"
    write_token_securely(token_path, json.dumps({"refresh_token": "secret"}))

    assert json.loads(token_path.read_text(encoding="utf-8"))["refresh_token"] == "secret"
    mode = stat.S_IMODE(token_path.stat().st_mode)
    assert mode & (stat.S_IRGRP | stat.S_IROTH | stat.S_IWGRP | stat.S_IWOTH) == 0
    assert mode == stat.S_IRUSR | stat.S_IWUSR


# --- Obsidian vault traversal ------------------------------------------------


def test_vault_under_a_dot_directory_is_still_indexed(tmp_path: Path) -> None:
    # The filter used to inspect the absolute path, so a vault living anywhere
    # below a dot-directory (~/.notes/vault, a synced folder) yielded nothing.
    walk = _iter_markdown_files()
    vault = tmp_path / ".notes" / "vault"
    (vault / "sub").mkdir(parents=True)
    (vault / "keep.md").write_text("# keep", encoding="utf-8")
    (vault / "sub" / "deep.md").write_text("# deep", encoding="utf-8")

    found = {path.name for path in walk(vault.resolve())}

    assert found == {"keep.md", "deep.md"}


def test_hidden_folders_inside_the_vault_are_still_skipped(tmp_path: Path) -> None:
    walk = _iter_markdown_files()
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    (vault / "note.md").write_text("# note", encoding="utf-8")
    (vault / ".obsidian" / "workspace.md").write_text("internal", encoding="utf-8")

    found = {path.name for path in walk(vault.resolve())}

    assert found == {"note.md"}


# --- reference library: never delete before you can replace ------------------


class _FakeCollection:
    def __init__(self) -> None:
        self.documents: list[str] = ["conteúdo antigo"]
        self.deletes = 0

    def delete(self, **_kwargs: object) -> None:
        self.deletes += 1
        self.documents = []

    def upsert(self, **kwargs: object) -> None:
        self.documents = list(kwargs.get("documents") or [])

    def get(self, **_kwargs: object) -> dict[str, object]:
        return {"ids": [], "metadatas": [], "documents": []}


class _BrokenEmbedding:
    def embed(self, text: str) -> list[float]:
        raise RuntimeError("model unavailable")

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        raise RuntimeError("model unavailable")


def _library_with(collection: _FakeCollection, embedding: object):
    """Build a ReferenceLibrary without touching ChromaDB."""
    from fear.library.reference_library import ReferenceLibrary

    library = ReferenceLibrary.__new__(ReferenceLibrary)
    library._collection = collection  # type: ignore[attr-defined]
    library._embedding = embedding  # type: ignore[attr-defined]
    return library


def test_a_failing_embedder_does_not_destroy_the_previous_note() -> None:
    # index_text used to delete the old chunks first, so an embedder failure
    # left the note gone with no replacement.
    collection = _FakeCollection()
    library = _library_with(collection, _BrokenEmbedding())

    with pytest.raises(RuntimeError):
        library.index_text("novo conteúdo bem longo " * 10, source="nota", user_id="u1")

    assert collection.deletes == 0
    assert collection.documents == ["conteúdo antigo"]  # untouched


def test_successful_reindex_still_replaces_the_old_chunks() -> None:
    class _Embedding:
        def embed_many(self, texts: list[str]) -> list[list[float]]:
            return [[0.0] for _ in texts]

    collection = _FakeCollection()
    library = _library_with(collection, _Embedding())

    written = library.index_text("conteúdo novo", source="nota", user_id="u1")

    assert written == 1
    assert collection.deletes == 1  # edit semantics preserved
    assert collection.documents == ["conteúdo novo"]


# --- temp-file discipline in the audio stack ---------------------------------


def test_remote_tts_closes_the_descriptor_it_opens(monkeypatch, tmp_path: Path) -> None:
    # mkstemp returns an open fd; dropping it leaked one descriptor per reply
    # and kept the bytes on disk even after the caller unlinked the path.
    fake_pyttsx3 = types.ModuleType("pyttsx3")
    fake_pyttsx3.init = lambda: None  # type: ignore[attr-defined]
    fake_requests = types.ModuleType("requests")

    class _Response:
        content = b"audio-bytes"

        def raise_for_status(self) -> None:
            return None

    fake_requests.post = lambda *_a, **_k: _Response()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pyttsx3", fake_pyttsx3)
    monkeypatch.setitem(sys.modules, "requests", fake_requests)

    from fear.audio.natural_tts import NaturalTTS

    tts = NaturalTTS()
    tts.remote_api_key = "key"
    tts.default_voice = "voice"

    open_fds_before = len(list(Path("/proc/self/fd").iterdir()))
    produced = [asyncio.run(tts.say("olá")) for _ in range(5)]
    open_fds_after = len(list(Path("/proc/self/fd").iterdir()))

    assert all(path is not None and path.read_bytes() == b"audio-bytes" for path in produced)
    assert open_fds_after == open_fds_before  # nothing leaked
    for path in produced:
        assert path is not None
        path.unlink(missing_ok=True)


# --- Obsidian notes belong to the machine's owner -----------------------------


class _RecordingMemory:
    def __init__(self) -> None:
        self.added: list[tuple[str, str]] = []

    def add_memory(self, text: str, speaker: str, source: str, user_id: str = "") -> str:
        self.added.append((text, user_id))
        return "id"


def _obsidian_handler(memory: _RecordingMemory, vault: Path, owner: str = "owner-id"):
    pytest.importorskip("watchdog")
    from fear.memory.obsidian_watcher import ObsidianMarkdownHandler

    return ObsidianMarkdownHandler(
        memory=memory,  # type: ignore[arg-type]
        user_id=lambda: owner,
        vault_root=vault.resolve(),
        debounce_seconds=0,
    )


def _file_event(path: Path):
    return types.SimpleNamespace(is_directory=False, src_path=str(path))


def test_obsidian_notes_are_stored_under_the_owner(tmp_path: Path) -> None:
    # Unowned notes were invisible to every signed-in user.
    memory = _RecordingMemory()
    note = tmp_path / "note.md"
    note.write_text("Uma ideia longa o suficiente para virar memória.", encoding="utf-8")

    _obsidian_handler(memory, tmp_path).on_modified(_file_event(note))

    assert memory.added == [("Uma ideia longa o suficiente para virar memória.", "owner-id")]


def test_live_obsidian_events_skip_hidden_folders(tmp_path: Path) -> None:
    # The initial walk skipped .trash/.obsidian, but live edits there were indexed.
    memory = _RecordingMemory()
    trashed = tmp_path / ".trash" / "old.md"
    trashed.parent.mkdir()
    trashed.write_text("Uma nota apagada que não deve voltar à memória.", encoding="utf-8")

    _obsidian_handler(memory, tmp_path).on_created(_file_event(trashed))

    assert memory.added == []


# --- microphone loops back off instead of spinning ---------------------------


def _audio_stubs(monkeypatch, *, whisper_loads: bool = True) -> None:
    """Fake pyaudio + whisper so the listeners import without the audio stack."""
    fake_pyaudio = types.ModuleType("pyaudio")
    fake_pyaudio.paInt16 = 8  # type: ignore[attr-defined]
    fake_pyaudio.PyAudio = object  # type: ignore[attr-defined]
    fake_whisper = types.ModuleType("whisper")

    def load_model(name: str):
        if not whisper_loads:
            raise RuntimeError("no model")
        return object()

    fake_whisper.load_model = load_model  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pyaudio", fake_pyaudio)
    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)
    monkeypatch.delitem(sys.modules, "fear.audio.voice_listener", raising=False)
    monkeypatch.delitem(sys.modules, "fear.input.clap_detector", raising=False)


def test_voice_recorder_backs_off_while_the_mic_fails(monkeypatch) -> None:
    _audio_stubs(monkeypatch)
    from fear.audio.voice_listener import VoiceListener

    listener = VoiceListener()
    attempts: list[float] = []

    def broken_mic(seconds: float) -> Path:
        attempts.append(seconds)
        raise OSError("no input device")

    listener._record_wav_file = broken_mic  # type: ignore[method-assign]
    waits: list[float] = []

    def fake_wait(timeout: float | None = None) -> bool:
        waits.append(timeout or 0.0)
        if len(waits) >= 4:
            listener._stop_event.set()
        return listener._stop_event.is_set()

    listener._stop_event.wait = fake_wait  # type: ignore[method-assign]
    listener.begin_capture()
    listener._recording_loop()

    assert waits == [1.0, 2.0, 4.0, 8.0]  # 1s, 2s, 4s… instead of retrying at once


def test_voice_listener_stops_recording_when_whisper_fails(monkeypatch, tmp_path: Path) -> None:
    # Without a model nothing drains the queue: recordings used to pile up in /tmp.
    _audio_stubs(monkeypatch, whisper_loads=False)
    from fear.audio.voice_listener import VoiceListener

    listener = VoiceListener()
    stale = tmp_path / "queued.wav"
    stale.write_bytes(b"RIFF")
    listener._audio_queue.put(stale)
    listener.begin_capture()

    listener._transcription_loop()

    assert listener._stop_event.is_set()
    assert not listener._capture_event.is_set()
    assert not stale.exists()
    recorded: list[float] = []
    listener._record_wav_file = lambda seconds: recorded.append(seconds)  # type: ignore[method-assign]
    listener.capture_once()
    assert recorded == []


def test_clap_detector_gives_up_on_a_dead_microphone(monkeypatch) -> None:
    _audio_stubs(monkeypatch)
    from fear.input import clap_detector as module

    class DeadStream:
        reads = 0

        def read(self, size: int, exception_on_overflow: bool = False) -> bytes:
            DeadStream.reads += 1
            raise OSError("device unplugged")

        def is_active(self) -> bool:
            return False

        def close(self) -> None:
            pass

    class FakePyAudio:
        def open(self, **kwargs):
            return DeadStream()

        def terminate(self) -> None:
            pass

    monkeypatch.setattr(module.pyaudio, "PyAudio", FakePyAudio)
    detector = module.ClapDetector(on_double_clap=lambda: None)
    detector._stop_event.wait = lambda timeout=None: False  # type: ignore[method-assign]

    detector._audio_loop()  # used to loop forever on the same OSError

    assert DeadStream.reads == module._MAX_READ_FAILURES


# --- Obsidian: notes written while F.E.A.R. was closed still reach memory ------


def _watcher(memory: _RecordingMemory, vault: Path, state: Path):
    pytest.importorskip("watchdog")
    from fear.memory.obsidian_watcher import ObsidianWatcher

    return ObsidianWatcher(vault_path=vault, memory=memory, state_file=state)  # type: ignore[arg-type]


def test_obsidian_catch_up_indexes_the_vault_once_then_only_changes(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    old, new = vault / "antiga.md", vault / "nova.md"
    old.write_text("Uma nota que já existia antes do F.E.A.R. abrir.", encoding="utf-8")
    new.write_text("Outra nota que já existia antes do F.E.A.R. abrir.", encoding="utf-8")
    memory = _RecordingMemory()
    state = tmp_path / "obsidian_state.json"

    assert _watcher(memory, vault, state).catch_up() == 2  # the first time: everything
    assert _watcher(memory, vault, state).catch_up() == 0  # nothing changed since
    later = time.time() + 5
    os.utime(new, (later, later))  # edited while F.E.A.R. was closed
    assert _watcher(memory, vault, state).catch_up() == 1


def test_an_interrupted_catch_up_is_not_recorded(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "nota.md").write_text(
        "Uma nota longa o suficiente para virar memória.", encoding="utf-8"
    )
    state = tmp_path / "obsidian_state.json"
    watcher = _watcher(_RecordingMemory(), vault, state)
    watcher._stop_event.set()

    assert watcher.catch_up() == 0
    assert not state.exists()  # the next start scans again

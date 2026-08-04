"""Regression tests for the backend bug sweep.

Each test here pins one concrete defect that was reachable in production: a
wrong Spotify action, a boot-time crash, a lost note, a world-readable token, or
an unindexable vault. They exercise the real functions — the only stand-ins are
for the third-party services themselves.
"""

from __future__ import annotations

import asyncio
import json
import stat
import sys
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

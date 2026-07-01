from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fear.auth import Security, UserStore
from fear.brain.async_conversation import CommandResponse
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemoryResult
from fear.web.app import (
    app,
    get_brain,
    get_memory,
    get_reference_library,
    get_security,
    get_settings,
    get_tts,
    get_user_store,
)

PERSONA_MODES = ["equilibrio", "sombrio", "cirurgico"]


class FakeBrain:
    def __init__(self) -> None:
        self.reset_calls: list[str] = []
        self.model = "openai/gpt-oss-120b:free"
        self.persona_mode = "equilibrio"
        # Records the per-request UserContext (or None) the last call received.
        self.last_user: object | None = None

    async def process_command(
        self, text: str, speaker: str = "user", user: object | None = None
    ) -> CommandResponse:
        self.last_user = user
        return CommandResponse(reply=f"echo: {text}", speaker=speaker, remembered=True)

    async def stream_command(
        self, text: str, speaker: str = "user", user: object | None = None
    ) -> AsyncIterator[str]:
        self.last_user = user
        for piece in ["parte 1 ", "parte 2"]:
            yield piece

    def reset_conversation(self, speaker: str) -> None:
        self.reset_calls.append(speaker)

    def set_chat_model(self, model: str) -> None:
        if model.strip():
            self.model = model.strip()

    def set_persona_mode(self, mode: str) -> None:
        if mode not in PERSONA_MODES:
            raise ValueError(mode)
        self.persona_mode = mode

    def get_config(self) -> dict[str, object]:
        return {
            "model": self.model,
            "persona_mode": self.persona_mode,
            "persona_modes": PERSONA_MODES,
        }


class FakeMemory:
    def get_facts_about_speaker(
        self, speaker: str, n_results: int = 10
    ) -> list[PersonalMemoryResult]:
        return [
            PersonalMemoryResult(
                id="m-1", text="uma lembrança", speaker=speaker, source="voice", timestamp=1.0
            )
        ]

    def forget(self, memory_id: str) -> bool:
        return bool(memory_id)


class FakeTTS:
    def __init__(self) -> None:
        self.said: list[str] = []

    async def say(self, text: str) -> None:
        self.said.append(text)
        return None


class FakeReferenceLibrary:
    """In-memory stand-in for the ChromaDB-backed library (no ML deps)."""

    def __init__(self) -> None:
        self.sources: dict[str, int] = {}

    def index_text(self, text: str, *, source: str, section: str = "nota") -> int:
        chunks = max(1, len(text) // 80)
        self.sources[source] = chunks
        return chunks

    def index_folder(self, folder: object, *, source: str) -> int:
        self.sources[source] = 3
        return 3

    def index_file(self, path: object, *, source: str) -> int:
        self.sources[source] = 1
        return 1

    def list_sources(self) -> list[dict[str, object]]:
        return [{"source": name, "chunks": count} for name, count in sorted(self.sources.items())]

    def delete_source(self, source: str) -> int:
        return self.sources.pop(source, 0)


@pytest.fixture
def brain() -> FakeBrain:
    return FakeBrain()


@pytest.fixture
def library() -> FakeReferenceLibrary:
    return FakeReferenceLibrary()


@pytest.fixture
def client(brain: FakeBrain, library: FakeReferenceLibrary, tmp_path: Path) -> Iterator[TestClient]:
    # Override the dependency providers and skip the lifespan (no hardware/ML deps).
    # chroma_path points at a tmp dir so /config persistence writes land there.
    security = Security("test-secret")
    user_store = UserStore(path=str(tmp_path / "users.db"), security=security)
    app.dependency_overrides[get_brain] = lambda: brain
    app.dependency_overrides[get_memory] = FakeMemory
    app.dependency_overrides[get_tts] = FakeTTS
    app.dependency_overrides[get_reference_library] = lambda: library
    app.dependency_overrides[get_user_store] = lambda: user_store
    app.dependency_overrides[get_security] = lambda: security
    app.dependency_overrides[get_settings] = lambda: Settings(
        openrouter_api_key="", openrouter_chat_model="", chroma_path=str(tmp_path / "chroma")
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        user_store.close()


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_status(client: TestClient) -> None:
    response = client.get("/status")
    assert response.status_code == 200
    body = response.json()
    assert body["assistant"] == "F.E.A.R."
    assert body["openrouter"] is False  # no API key in defaults
    assert set(body) == {
        "assistant",
        "openrouter",
        "memory",
        "voice",
        "spotify",
        "obsidian",
        "calendar",
    }


def test_command(client: TestClient) -> None:
    response = client.post("/command", json={"text": "oi", "speaker": "Lucas", "speak": False})
    assert response.status_code == 200
    assert response.json() == {"reply": "echo: oi", "speaker": "Lucas", "audio_file": None}


def test_command_anonymous_has_no_user_context(client: TestClient, brain: FakeBrain) -> None:
    client.post("/command", json={"text": "oi", "speaker": "Lucas", "speak": False})
    # No token -> the brain runs in shared, single-user mode.
    assert brain.last_user is None


def test_command_logged_in_passes_user_context(client: TestClient, brain: FakeBrain) -> None:
    registered = client.post(
        "/auth/register", json={"email": "u@example.com", "password": "longenough"}
    ).json()
    token = registered["token"]

    response = client.post(
        "/command",
        json={"text": "oi", "speaker": "u", "speak": False},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    # The route resolved the token to a user and handed the brain their context.
    assert brain.last_user is not None
    assert brain.last_user.user_id == registered["user"]["id"]


def test_command_stream(client: TestClient) -> None:
    response = client.post("/command/stream", json={"text": "oi", "speaker": "Lucas"})
    assert response.status_code == 200
    assert response.text == "parte 1 parte 2"


def test_memory(client: TestClient) -> None:
    response = client.get("/memory/Lucas")
    assert response.status_code == 200
    body = response.json()
    assert body["speaker"] == "Lucas"
    assert body["memories"][0]["text"] == "uma lembrança"
    assert body["memories"][0]["id"] == "m-1"


def test_memory_forget(client: TestClient) -> None:
    response = client.post("/memory/forget", json={"memory_id": "m-1"})
    assert response.status_code == 200
    assert response.json() == {"forgotten": True, "id": "m-1"}


def test_wearable_tap(client: TestClient) -> None:
    response = client.post("/wearable/tap", json={"gesture": "double_tap", "speaker": "Lucas"})
    assert response.status_code == 200
    # double_tap maps to "next Spotify song", which the fake brain echoes back.
    assert response.json()["reply"] == "echo: next Spotify song"


def test_conversation_reset(client: TestClient, brain: FakeBrain) -> None:
    response = client.post("/conversation/reset", params={"speaker": "Lucas"})
    assert response.status_code == 200
    assert response.json() == {"status": "reset", "speaker": "Lucas"}
    assert brain.reset_calls == ["Lucas"]


def test_knowledge_list_starts_empty(client: TestClient) -> None:
    response = client.get("/knowledge")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["sources"] == []


def test_knowledge_add_text_then_list(client: TestClient) -> None:
    response = client.post(
        "/knowledge/text",
        json={"name": "Manifesto", "content": "ideia " * 100},
    )
    assert response.status_code == 200
    assert response.json()["source"] == "Manifesto"
    assert response.json()["chunks"] >= 1

    listed = client.get("/knowledge").json()
    assert "Manifesto" in [item["source"] for item in listed["sources"]]


def test_knowledge_add_text_rejects_empty_content(client: TestClient) -> None:
    response = client.post("/knowledge/text", json={"name": "x", "content": "   "})
    assert response.status_code == 422


def test_knowledge_delete(client: TestClient, library: FakeReferenceLibrary) -> None:
    library.sources["Antigo"] = 4
    response = client.delete("/knowledge/Antigo")
    assert response.status_code == 200
    assert response.json() == {"source": "Antigo", "deleted": 4}
    assert "Antigo" not in library.sources


def test_knowledge_path_blocked_for_non_local_client(client: TestClient) -> None:
    # The TestClient is treated as a non-local caller (e.g. a phone on the LAN),
    # so indexing an arbitrary server path is refused.
    response = client.post("/knowledge/path", json={"path": "/tmp/whatever"})
    assert response.status_code == 403


def test_knowledge_unavailable_returns_503(client: TestClient) -> None:
    # Simulate the library failing to initialize (e.g. ML deps missing).
    app.dependency_overrides[get_reference_library] = lambda: None

    listed = client.get("/knowledge").json()
    assert listed == {"available": False, "sources": []}

    response = client.post("/knowledge/text", json={"name": "x", "content": "y"})
    assert response.status_code == 503


def test_config_get(client: TestClient) -> None:
    response = client.get("/config")
    assert response.status_code == 200
    body = response.json()
    assert body["persona_mode"] == "equilibrio"
    assert "sombrio" in body["persona_modes"]
    assert body["model_default"]


def test_config_set_model_and_mode(client: TestClient, brain: FakeBrain) -> None:
    response = client.post(
        "/config",
        json={"model": "deepseek/deepseek-chat", "persona_mode": "sombrio"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "deepseek/deepseek-chat"
    assert body["persona_mode"] == "sombrio"
    assert brain.model == "deepseek/deepseek-chat"
    assert brain.persona_mode == "sombrio"


def test_config_rejects_invalid_mode(client: TestClient) -> None:
    response = client.post("/config", json={"persona_mode": "caotico"})
    assert response.status_code == 422

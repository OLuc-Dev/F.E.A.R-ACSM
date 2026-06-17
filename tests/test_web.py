from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi.testclient import TestClient

from fear.brain.async_conversation import CommandResponse
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemoryResult
from fear.web.app import app, get_brain, get_memory, get_settings, get_tts


class FakeBrain:
    def __init__(self) -> None:
        self.reset_calls: list[str] = []

    async def process_command(self, text: str, speaker: str = "user") -> CommandResponse:
        return CommandResponse(reply=f"echo: {text}", speaker=speaker, remembered=True)

    async def stream_command(self, text: str, speaker: str = "user") -> AsyncIterator[str]:
        for piece in ["parte 1 ", "parte 2"]:
            yield piece

    def reset_conversation(self, speaker: str) -> None:
        self.reset_calls.append(speaker)


class FakeMemory:
    def get_facts_about_speaker(
        self, speaker: str, n_results: int = 10
    ) -> list[PersonalMemoryResult]:
        return [
            PersonalMemoryResult(
                text="uma lembrança", speaker=speaker, source="voice", timestamp=1.0
            )
        ]


class FakeTTS:
    def __init__(self) -> None:
        self.said: list[str] = []

    async def say(self, text: str) -> None:
        self.said.append(text)
        return None


@pytest.fixture
def brain() -> FakeBrain:
    return FakeBrain()


@pytest.fixture
def client(brain: FakeBrain) -> Iterator[TestClient]:
    # Override the dependency providers and skip the lifespan (no hardware/ML deps).
    app.dependency_overrides[get_brain] = lambda: brain
    app.dependency_overrides[get_memory] = FakeMemory
    app.dependency_overrides[get_tts] = FakeTTS
    app.dependency_overrides[get_settings] = lambda: Settings(
        openrouter_api_key="", openrouter_chat_model=""
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


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
    assert set(body) == {"assistant", "openrouter", "memory", "voice", "spotify", "obsidian"}


def test_command(client: TestClient) -> None:
    response = client.post("/command", json={"text": "oi", "speaker": "Lucas", "speak": False})
    assert response.status_code == 200
    assert response.json() == {"reply": "echo: oi", "speaker": "Lucas", "audio_file": None}


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

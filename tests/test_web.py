from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from fear.auth import Security, UserStore
from fear.brain.async_conversation import CommandResponse
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemoryResult
from fear.web.app import (
    app,
    get_brain,
    get_memory,
    get_rate_limiter,
    get_reference_library,
    get_security,
    get_settings,
    get_tts,
    get_user_store,
    resolve_secret_key,
)
from fear.web.ratelimit import RateLimiter

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
    def recent_for_user(self, user_id: str, n_results: int = 20) -> list[PersonalMemoryResult]:
        return [
            PersonalMemoryResult(
                id="m-1", text="uma lembrança", speaker="voz", source="voice", timestamp=1.0
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

    def index_text(
        self, text: str, *, source: str, section: str = "nota", user_id: str = ""
    ) -> int:
        chunks = max(1, len(text) // 80)
        self.sources[source] = chunks
        return chunks

    def list_sources(self, user_id: str = "") -> list[dict[str, object]]:
        return [{"source": name, "chunks": count} for name, count in sorted(self.sources.items())]

    def delete_source(self, source: str, user_id: str = "") -> int:
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
    rate_limiter = RateLimiter()  # fresh per test, so buckets don't leak across tests
    app.dependency_overrides[get_user_store] = lambda: user_store
    app.dependency_overrides[get_security] = lambda: security
    app.dependency_overrides[get_rate_limiter] = lambda: rate_limiter
    app.dependency_overrides[get_settings] = lambda: Settings(
        openrouter_api_key="", openrouter_chat_model="", chroma_path=str(tmp_path / "chroma")
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()
        user_store.close()


def _register(
    client: TestClient, email: str = "t@example.com", password: str = "longenough"
) -> tuple[dict[str, object], dict[str, str]]:
    """Register a user; return (user dict, Authorization header) for authed calls."""
    body = client.post("/auth/register", json={"email": email, "password": password}).json()
    return body["user"], {"Authorization": f"Bearer {body['token']}"}


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


def test_command_requires_auth(client: TestClient) -> None:
    response = client.post("/command", json={"text": "oi", "speaker": "Lucas", "speak": False})
    assert response.status_code == 401


def test_command(client: TestClient, brain: FakeBrain) -> None:
    user, headers = _register(client)
    response = client.post(
        "/command", json={"text": "oi", "speaker": "Lucas", "speak": False}, headers=headers
    )
    assert response.status_code == 200
    assert response.json() == {"reply": "echo: oi", "speaker": "Lucas", "audio_file": None}
    # The route resolved the token and handed the brain that user's context.
    assert brain.last_user is not None
    assert brain.last_user.user_id == user["id"]


def test_command_stream(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.post(
        "/command/stream", json={"text": "oi", "speaker": "Lucas"}, headers=headers
    )
    assert response.status_code == 200
    assert response.text == "parte 1 parte 2"


def test_memory_requires_auth(client: TestClient) -> None:
    assert client.get("/memory").status_code == 401


def test_memory(client: TestClient) -> None:
    user, headers = _register(client)
    response = client.get("/memory", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["speaker"] == user["email"]
    assert body["memories"][0]["text"] == "uma lembrança"
    assert body["memories"][0]["id"] == "m-1"


def test_memory_forget_only_own(client: TestClient) -> None:
    user, headers = _register(client)
    mine = f"{user['id']}-voice-abc"
    response = client.post("/memory/forget", json={"memory_id": mine}, headers=headers)
    assert response.status_code == 200
    assert response.json() == {"forgotten": True, "id": mine}

    # An id not prefixed with this user's id (someone else's) is refused.
    other = client.post("/memory/forget", json={"memory_id": "other-user-xyz"}, headers=headers)
    assert other.json() == {"forgotten": False, "id": "other-user-xyz"}


def test_wearable_tap_requires_auth(client: TestClient) -> None:
    response = client.post("/wearable/tap", json={"gesture": "double_tap", "speaker": "Lucas"})
    assert response.status_code == 401


def test_wearable_tap(client: TestClient, brain: FakeBrain) -> None:
    _, headers = _register(client)
    response = client.post(
        "/wearable/tap", json={"gesture": "double_tap", "speaker": "Lucas"}, headers=headers
    )
    assert response.status_code == 200
    # double_tap maps to "next Spotify song", which the fake brain echoes back.
    assert response.json()["reply"] == "echo: next Spotify song"
    # It ran on the signed-in user's context, not an anonymous/global one.
    assert brain.last_user is not None


# --- item 1: FEAR_SECRET_KEY fail-fast ---


def test_resolve_secret_key_uses_configured_value() -> None:
    assert resolve_secret_key(Settings(env="production", secret_key="abc")) == "abc"


def test_resolve_secret_key_is_fatal_in_production_when_unset() -> None:
    with pytest.raises(RuntimeError):
        resolve_secret_key(Settings(env="production", secret_key=""))


def test_resolve_secret_key_is_ephemeral_outside_production() -> None:
    # Local/dev keeps the permissive behaviour: a non-empty ephemeral secret, no raise.
    assert resolve_secret_key(Settings(env="local", secret_key=""))


# --- item 2: /ws requires an auth handshake ---


def test_ws_rejects_without_auth_handshake(
    client: TestClient, brain: FakeBrain, tmp_path: Path
) -> None:
    # /ws reads shared objects from app.state (populated at startup); set them for
    # the test, then confirm a non-auth first message closes the socket untouched.
    security = Security("test-secret")
    ws_store = UserStore(path=str(tmp_path / "ws.db"), security=security)
    app.state.user_store = ws_store
    app.state.security = security
    app.state.settings = Settings(secret_key="test-secret")
    app.state.brain = brain
    try:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "hello"})  # not an auth handshake
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
    finally:
        ws_store.close()
        for attr in ("user_store", "security", "settings", "brain"):
            if hasattr(app.state, attr):
                delattr(app.state, attr)


# --- item 5: auth hardening ---


def test_login_is_rate_limited(client: TestClient) -> None:
    # The limiter (default 10/window) triggers before credential checks, so the
    # 11th attempt from the same client is refused with 429.
    statuses = [
        client.post(
            "/auth/login", json={"email": "x@example.com", "password": "whatever"}
        ).status_code
        for _ in range(11)
    ]
    assert statuses[0] == 401  # wrong creds, but allowed through
    assert statuses[-1] == 429  # rate limited


def test_logout_all_revokes_existing_sessions(client: TestClient) -> None:
    _, headers = _register(client, email="revoke@example.com")
    assert client.get("/auth/me", headers=headers).status_code == 200

    out = client.post("/auth/logout-all", headers=headers)
    assert out.status_code == 200 and out.json() == {"logged_out": True}

    # The token minted before the bump is now revoked.
    assert client.get("/auth/me", headers=headers).status_code == 401


def test_register_requires_invite_when_configured(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(invite_code="LETMEIN")
    base = {"email": "invited@example.com", "password": "longenough"}
    assert client.post("/auth/register", json=base).status_code == 403
    assert client.post("/auth/register", json={**base, "invite_code": "nope"}).status_code == 403
    assert client.post("/auth/register", json={**base, "invite_code": "LETMEIN"}).status_code == 200


def test_conversation_reset(client: TestClient, brain: FakeBrain) -> None:
    user, headers = _register(client)
    response = client.post("/conversation/reset", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"status": "reset", "speaker": user["email"]}
    # History is reset by the user's id, not a free-text speaker.
    assert brain.reset_calls == [user["id"]]


def test_knowledge_requires_auth(client: TestClient) -> None:
    assert client.get("/knowledge").status_code == 401


def test_knowledge_list_starts_empty(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.get("/knowledge", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["sources"] == []


def test_knowledge_add_text_then_list(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.post(
        "/knowledge/text", json={"name": "Manifesto", "content": "ideia " * 100}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["source"] == "Manifesto"
    assert response.json()["chunks"] >= 1

    listed = client.get("/knowledge", headers=headers).json()
    assert "Manifesto" in [item["source"] for item in listed["sources"]]


def test_knowledge_add_text_rejects_empty_content(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.post("/knowledge/text", json={"name": "x", "content": "   "}, headers=headers)
    assert response.status_code == 422


def test_knowledge_delete(client: TestClient, library: FakeReferenceLibrary) -> None:
    _, headers = _register(client)
    library.sources["Antigo"] = 4
    response = client.delete("/knowledge/Antigo", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"source": "Antigo", "deleted": 4}
    assert "Antigo" not in library.sources


def test_knowledge_unavailable_returns_503(client: TestClient) -> None:
    # Simulate the library failing to initialize (e.g. ML deps missing).
    _, headers = _register(client)
    app.dependency_overrides[get_reference_library] = lambda: None

    listed = client.get("/knowledge", headers=headers).json()
    assert listed == {"available": False, "sources": []}

    response = client.post("/knowledge/text", json={"name": "x", "content": "y"}, headers=headers)
    assert response.status_code == 503


def test_config_requires_auth(client: TestClient) -> None:
    assert client.get("/config").status_code == 401


def test_config_get(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.get("/config", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["persona_mode"] == "equilibrio"  # default until the user changes it
    assert "sombrio" in body["persona_modes"]
    assert body["model_default"]


def test_config_set_model_and_mode_persists_per_user(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.post(
        "/config",
        json={"model": "deepseek/deepseek-chat", "persona_mode": "sombrio"},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "deepseek/deepseek-chat"
    assert body["persona_mode"] == "sombrio"
    # The choice is saved on the account: a fresh read returns it.
    reread = client.get("/config", headers=headers).json()
    assert reread["model"] == "deepseek/deepseek-chat"
    assert reread["persona_mode"] == "sombrio"


def test_config_rejects_invalid_mode(client: TestClient) -> None:
    _, headers = _register(client)
    response = client.post("/config", json={"persona_mode": "caotico"}, headers=headers)
    assert response.status_code == 422

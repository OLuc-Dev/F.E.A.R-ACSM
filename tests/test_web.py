from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from fear.audio.online_voice import OnlineVoiceError
from fear.auth import Security, UserStore
from fear.brain.async_conversation import CommandResponse, StreamSession
from fear.brain.local_models import LocalModel
from fear.brain.models import FALLBACK_MODELS, ModelInfo
from fear.config import DEFAULT_CHAT_MODEL, Settings
from fear.memory.personal_memory import PersonalMemoryResult
from fear.web import app as app_module
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


class FakeBrain:
    def __init__(self) -> None:
        self.reset_calls: list[str] = []
        # Records the per-request UserContext (or None) the last call received.
        self.last_user: object | None = None
        # Consulted-memory ids the fake stream reports (controllable per test).
        self.consulted_ids: list[str] = []

    async def process_command(
        self, text: str, speaker: str = "user", user: object | None = None
    ) -> CommandResponse:
        self.last_user = user
        return CommandResponse(reply=f"echo: {text}", speaker=speaker, remembered=True)

    async def open_stream(
        self, text: str, speaker: str = "user", user: object | None = None
    ) -> StreamSession:
        self.last_user = user

        async def _tokens() -> AsyncIterator[str]:
            for piece in ["parte 1 ", "parte 2"]:
                yield piece

        return StreamSession(consulted_memory_ids=self.consulted_ids, stream=_tokens())

    def reset_conversation(self, speaker: str) -> None:
        self.reset_calls.append(speaker)


class FakeMemory:
    def recent_for_user(
        self, user_id: str, n_results: int = 20, include_assistant_replies: bool = True
    ) -> list[PersonalMemoryResult]:
        items = [
            PersonalMemoryResult(
                id="m-1", text="uma lembrança", speaker="voz", source="voice", timestamp=1.0
            )
        ]
        # Mirror the store: F.E.A.R.'s own replies only come back when asked for.
        if include_assistant_replies:
            items.append(
                PersonalMemoryResult(
                    id="r-1",
                    text="resposta interna",
                    speaker="fear",
                    source="assistant_reply",
                    timestamp=2.0,
                )
            )
        return items

    def forget_for_user(self, memory_id: str, user_id: str) -> bool:
        # The real ownership check lives in the store (integration-tested). Here
        # we simulate its verdict: ids starting with "own" belong to the caller.
        return memory_id.startswith("own")


class FakeTTS:
    """Stands in for NaturalTTS, which returns the temp file it synthesised."""

    def __init__(self) -> None:
        self.said: list[str] = []
        self.produced: list[Path] = []

    async def say(self, text: str) -> Path | None:
        self.said.append(text)
        handle, name = tempfile.mkstemp(suffix=".wav")
        os.close(handle)
        path = Path(name)
        self.produced.append(path)
        return path


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
        "music",
        "voice_input",
        "voice_output",
        "voice_online",
        "local_models",
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


def test_command_stream_exposes_consulted_memory_ids(client: TestClient, brain: FakeBrain) -> None:
    # The consulted ids ride in a header (percent-encoded, comma-separated); the
    # body stays byte-for-byte the same tokens.
    _, headers = _register(client)
    brain.consulted_ids = ["u1-Ana-conversation-abc", "u1-Ze Silva-voice-9f"]
    response = client.post(
        "/command/stream", json={"text": "oi", "speaker": "Lucas"}, headers=headers
    )
    assert response.text == "parte 1 parte 2"
    assert (
        response.headers["X-Fear-Consulted-Memory-Ids"]
        == "u1-Ana-conversation-abc,u1-Ze%20Silva-voice-9f"  # space -> %20
    )


def test_command_stream_omits_header_when_nothing_consulted(
    client: TestClient, brain: FakeBrain
) -> None:
    _, headers = _register(client)
    brain.consulted_ids = []
    response = client.post(
        "/command/stream", json={"text": "oi", "speaker": "Lucas"}, headers=headers
    )
    assert response.text == "parte 1 parte 2"
    assert "X-Fear-Consulted-Memory-Ids" not in response.headers


def test_command_stream_header_is_cors_exposed(client: TestClient, brain: FakeBrain) -> None:
    # Cross-origin JS can only read the header if the server exposes it via CORS.
    _, headers = _register(client)
    brain.consulted_ids = ["u1-Ana-conversation-abc"]
    headers["Origin"] = "http://localhost:3000"
    response = client.post(
        "/command/stream", json={"text": "oi", "speaker": "Lucas"}, headers=headers
    )
    assert "X-Fear-Consulted-Memory-Ids" in response.headers.get(
        "access-control-expose-headers", ""
    )


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


def test_memory_excludes_assistant_replies_by_default(client: TestClient) -> None:
    # The inspector endpoint is UI-facing, so F.E.A.R.'s own replies are omitted
    # unless explicitly requested — they must not eat slots in the window.
    _, headers = _register(client)
    body = client.get("/memory", headers=headers).json()
    sources = [item["source"] for item in body["memories"]]
    assert "assistant_reply" not in sources
    assert "voice" in sources


def test_memory_can_include_assistant_replies(client: TestClient) -> None:
    _, headers = _register(client)
    body = client.get("/memory?include_assistant_replies=true", headers=headers).json()
    sources = [item["source"] for item in body["memories"]]
    assert "assistant_reply" in sources


def test_memory_forget_delegates_to_store_ownership(client: TestClient) -> None:
    # The endpoint returns the store's ownership verdict. The store (integration-
    # tested) allows a user to forget only their own memories, by metadata.
    _, headers = _register(client)
    mine = client.post("/memory/forget", json={"memory_id": "own-abc"}, headers=headers)
    assert mine.status_code == 200
    assert mine.json() == {"forgotten": True, "id": "own-abc"}

    # A memory the store says isn't the caller's is refused.
    other = client.post("/memory/forget", json={"memory_id": "someone-else"}, headers=headers)
    assert other.json() == {"forgotten": False, "id": "someone-else"}


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


# --- microphone endpoints must never be anonymous ---


class FakeVoiceListener:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def begin_capture(self) -> None:
        self.calls.append("begin")

    def end_capture(self) -> None:
        self.calls.append("end")

    def capture_once(self) -> None:
        self.calls.append("once")


VOICE_ROUTES = ("/voice/start", "/voice/stop", "/voice/capture-once")


def test_voice_routes_reject_anonymous_callers(client: TestClient) -> None:
    # These drive the machine's microphone. An unauthenticated caller on the LAN
    # must not be able to start, stop, or trigger a capture.
    listener = FakeVoiceListener()
    app.state.voice_listener = listener
    try:
        for path in VOICE_ROUTES:
            assert client.post(path).status_code == 401, path
        assert listener.calls == []  # the listener was never touched
    finally:
        delattr(app.state, "voice_listener")


def test_voice_routes_work_for_a_signed_in_user(client: TestClient) -> None:
    listener = FakeVoiceListener()
    app.state.voice_listener = listener
    try:
        _, headers = _register(client)
        for path in VOICE_ROUTES:
            assert client.post(path, headers=headers).status_code == 200, path
        assert listener.calls == ["begin", "end", "once"]
    finally:
        delattr(app.state, "voice_listener")


def test_voice_routes_report_disabled_when_no_listener(client: TestClient) -> None:
    # Auth still comes first, but with the listener off the answer is a clean
    # "disabled" hint rather than an error.
    _, headers = _register(client)
    body = client.post("/voice/capture-once", headers=headers).json()
    assert body["status"] == "disabled"


# --- synthesised audio must never pile up on disk ---


def test_command_deletes_the_audio_it_synthesised(client: TestClient) -> None:
    tts = FakeTTS()
    app.dependency_overrides[get_tts] = lambda: tts
    _, headers = _register(client)

    response = client.post(
        "/command", json={"text": "oi", "speaker": "Lucas", "speak": True}, headers=headers
    )

    assert response.status_code == 200
    assert tts.said  # it really spoke
    assert all(not path.exists() for path in tts.produced)  # and cleaned up after itself


@pytest.mark.asyncio
async def test_voice_replies_delete_their_audio_too() -> None:
    # The voice path used to drop the returned path, leaking one file per reply.
    tts = FakeTTS()
    await app_module.speak_and_cleanup(tts, "resposta falada")

    assert tts.said == ["resposta falada"]
    assert all(not path.exists() for path in tts.produced)


# --- invite code / email validation robustness ---


def test_non_ascii_invite_code_is_refused_not_a_500(client: TestClient) -> None:
    # hmac.compare_digest raises TypeError on non-ASCII str; the check must still
    # answer with a clean 403 instead of blowing up.
    app.dependency_overrides[get_settings] = lambda: Settings(invite_code="LETMEIN")
    response = client.post(
        "/auth/register",
        json={"email": "a@b.com", "password": "longenough", "invite_code": "convité"},
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Convite inválido."


def test_correct_invite_code_still_registers(client: TestClient) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(invite_code="LETMEIN")
    response = client.post(
        "/auth/register",
        json={"email": "ok@example.com", "password": "longenough", "invite_code": "LETMEIN"},
    )
    assert response.status_code == 200


def test_malformed_emails_are_rejected(client: TestClient) -> None:
    for email in ("a@b@c.com", "a b@c.com", "a@b", "@b.com"):
        response = client.post("/auth/register", json={"email": email, "password": "longenough"})
        assert response.status_code == 422, email


def _register_with_a_broken_route(client: TestClient, origin: str) -> object:
    """Force an unhandled error inside /auth/register and return the response.

    A dedicated client with ``raise_server_exceptions=False`` is used so the
    500 is returned like a real HTTP response instead of being re-raised.
    """
    app.dependency_overrides[get_settings] = lambda: Settings(invite_code="LETMEIN")

    def boom(_supplied: str, _expected: str) -> bool:
        raise RuntimeError("simulated failure")

    original = app_module._matches_invite
    app_module._matches_invite = boom  # type: ignore[assignment]
    # Not used as a context manager on purpose: entering it would run the
    # lifespan, which imports the optional audio/ML stack (absent in tests).
    quiet_client = TestClient(app, raise_server_exceptions=False)
    try:
        return quiet_client.post(
            "/auth/register",
            json={"email": "a@b.com", "password": "longenough", "invite_code": "LETMEIN"},
            headers={"Origin": origin},
        )
    finally:
        app_module._matches_invite = original  # type: ignore[assignment]


def test_unhandled_errors_carry_cors_headers(client: TestClient) -> None:
    # A 500 is served by ServerErrorMiddleware, outside CORSMiddleware, so the
    # handler must add the headers itself or the browser discards the body.
    response = _register_with_a_broken_route(client, "http://localhost:3000")

    assert response.status_code == 500  # type: ignore[attr-defined]
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"  # type: ignore[attr-defined]
    assert "Internal error" in response.json()["detail"]  # type: ignore[attr-defined]


def test_unhandled_errors_do_not_echo_a_foreign_origin(client: TestClient) -> None:
    response = _register_with_a_broken_route(client, "http://evil.example")

    assert response.status_code == 500  # type: ignore[attr-defined]
    assert "access-control-allow-origin" not in response.headers  # type: ignore[attr-defined]


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


class FakeCatalog:
    """OpenRouter's model list, as ModelCatalog reads it (None: unreachable)."""

    def __init__(self, models: set[str] | None, listed: list[ModelInfo] | None = None) -> None:
        self.models = models
        self.listed = listed

    async def offers(self, model: str) -> bool | None:
        return None if self.models is None else model in self.models

    async def listing(self) -> list[ModelInfo] | None:
        return self.listed


def test_models_lists_what_can_be_chosen_recommended_first(client: TestClient) -> None:
    listed = [
        ModelInfo("z/paid", "Z: Paid", "Pricey. Very.", 1000, 0.000003, 0.000015),
        ModelInfo("a/other:free", "A: Other (free)", "Another free one.", 2000),
        ModelInfo(FALLBACK_MODELS[0], "NVIDIA: Fallback (free)", "", 3000),
        ModelInfo(DEFAULT_CHAT_MODEL, "Default (free)", "The default. More text.", 4000),
        ModelInfo("x/painter", "X: Painter", "", 0, 0.00001, 0.00001, chat=False),
        # OpenRouter's routers other than free and auto do other jobs than chatting.
        ModelInfo("openrouter/bodybuilder", "Body Builder", "", 0, None, None),
    ]
    app.state.model_catalog = FakeCatalog(set(), listed)
    try:
        _, headers = _register(client)
        body = client.get("/models", headers=headers).json()
        ids = [model["id"] for model in body["models"]]
        assert ids == [DEFAULT_CHAT_MODEL, FALLBACK_MODELS[0], "a/other:free", "z/paid"]
        default, *_, paid = body["models"]
        assert default["name"] == "Default" and default["description"] == "The default"
        assert default["free"] is True and default["cost_per_100_replies"] is None
        # 100 replies of ~3,500 tokens in and ~300 out.
        assert paid["free"] is False and paid["cost_per_100_replies"] == 1.5
        assert body["default"] == DEFAULT_CHAT_MODEL
        assert body["fallbacks"] == list(FALLBACK_MODELS)
    finally:
        delattr(app.state, "model_catalog")


class FakeLocalOllama:
    """Ollama on this computer, for the routes: what it has, and downloads."""

    def __init__(self, tags: list[str] | None, pull_events: list[dict] | None = None) -> None:
        self.tags = tags
        self.pull_events = pull_events or []
        self.pulled: list[str] = []

    async def installed(self):
        if self.tags is None:
            return None
        return [LocalModel(tag, size=3_000_000_000, parameter_size="4.2B") for tag in self.tags]

    async def chat_models(self):
        return await self.installed() or []

    async def pull(self, tag: str):
        self.pulled.append(tag)
        for event in self.pull_events:
            yield event


def test_local_models_lists_whats_downloaded_and_what_to_download(client: TestClient) -> None:
    app.state.ollama = FakeLocalOllama(["qwen3.5:4b"])
    try:
        _, headers = _register(client)
        body = client.get("/models/local", headers=headers).json()
        assert body["running"] is True
        assert body["models"] == [
            {
                "id": "ollama/qwen3.5:4b",
                "tag": "qwen3.5:4b",
                "size": 3_000_000_000,
                "parameter_size": "4.2B",
            }
        ]
        offered = {download["tag"]: download["installed"] for download in body["downloads"]}
        assert offered == {"qwen3.5:4b": True, "gemma4:e4b": False}
        assert body["recommended"] == "qwen3.5:4b"
    finally:
        delattr(app.state, "ollama")


def test_local_models_says_when_ollama_isnt_there(client: TestClient) -> None:
    _, headers = _register(client)
    assert client.get("/models/local", headers=headers).json()["running"] is False  # not set up
    app.state.ollama = FakeLocalOllama(None)  # installed, but closed
    try:
        body = client.get("/models/local", headers=headers).json()
        assert body["running"] is False and body["models"] == []
    finally:
        delattr(app.state, "ollama")


def test_pull_streams_the_download_all_parts_together(client: TestClient) -> None:
    events = [
        {"status": "pulling manifest"},
        {"status": "pulling a", "digest": "sha256:a", "total": 1000, "completed": 500},
        {"status": "pulling b", "digest": "sha256:b", "total": 200},
        {"status": "pulling b", "digest": "sha256:b", "total": 200, "completed": 200},
        {"status": "success"},
    ]
    app.state.ollama = FakeLocalOllama([], events)
    try:
        _, owner = _register(client, "owner@example.com")
        response = client.post("/models/local/pull", json={"tag": "qwen3.5:4b"}, headers=owner)
        lines = [json.loads(line) for line in response.text.splitlines()]
        assert response.headers["content-type"].startswith("application/x-ndjson")
        assert lines[1] == {"status": "pulling a", "completed": 500, "total": 1000}
        assert lines[3] == {"status": "pulling b", "completed": 700, "total": 1200}
        assert lines[-1]["status"] == "success"
        assert app.state.ollama.pulled == ["qwen3.5:4b"]
    finally:
        delattr(app.state, "ollama")


def test_pull_is_for_the_owner_and_says_why_it_failed(client: TestClient) -> None:
    app.state.ollama = FakeLocalOllama([], [{"error": "pull model manifest: file does not exist"}])
    try:
        _, owner = _register(client, "owner@example.com")
        _, guest = _register(client, "guest@example.com")
        refused = client.post("/models/local/pull", json={"tag": "qwen3.5:4b"}, headers=guest)
        assert refused.status_code == 403
        failed = client.post("/models/local/pull", json={"tag": "nope:1b"}, headers=owner)
        assert [json.loads(line) for line in failed.text.splitlines()] == [
            {"error": "pull model manifest: file does not exist"}
        ]
        bad_tag = client.post("/models/local/pull", json={"tag": "../etc"}, headers=owner)
        assert bad_tag.status_code == 422
    finally:
        delattr(app.state, "ollama")


def test_config_takes_a_local_model_only_once_downloaded(client: TestClient) -> None:
    app.state.ollama = FakeLocalOllama(["qwen3.5:4b"])
    try:
        _, headers = _register(client)
        missing = client.post("/config", json={"model": "ollama/gemma4:e4b"}, headers=headers)
        assert missing.status_code == 422
        assert "não está baixado" in missing.json()["detail"]
        saved = client.post("/config", json={"model": "ollama/qwen3.5:4b"}, headers=headers)
        assert saved.status_code == 200 and saved.json()["model_available"] is True
        assert client.get("/status").json()["local_models"] is True
    finally:
        delattr(app.state, "ollama")


def test_models_says_when_openrouter_cant_be_read(client: TestClient) -> None:
    _, headers = _register(client)
    assert client.get("/models", headers=headers).status_code == 503  # no catalog at all
    app.state.model_catalog = FakeCatalog(None, None)
    try:
        response = client.get("/models", headers=headers)
        assert response.status_code == 503
        assert "lista de modelos" in response.json()["detail"]
    finally:
        delattr(app.state, "model_catalog")


def test_config_refuses_a_model_openrouter_doesnt_have(client: TestClient) -> None:
    app.state.model_catalog = FakeCatalog({"x/real:free"})
    try:
        _, headers = _register(client)
        refused = client.post("/config", json={"model": "x/gone:free"}, headers=headers)
        assert refused.status_code == 422
        assert "não tem o modelo x/gone:free" in refused.json()["detail"]
        saved = client.post("/config", json={"model": "x/real:free"}, headers=headers)
        assert saved.status_code == 200
        assert saved.json()["model"] == "x/real:free"
        assert saved.json()["model_available"] is True
    finally:
        delattr(app.state, "model_catalog")


def test_config_says_when_the_saved_model_was_retired(client: TestClient) -> None:
    app.state.model_catalog = FakeCatalog({"x/real:free"})
    try:
        _, headers = _register(client)
        client.post("/config", json={"model": "x/real:free"}, headers=headers)
        app.state.model_catalog.models = {"x/other:free"}  # OpenRouter retired it since
        assert client.get("/config", headers=headers).json()["model_available"] is False
        # Can't read the list (offline): nothing is refused, nothing is claimed.
        app.state.model_catalog.models = None
        assert client.get("/config", headers=headers).json()["model_available"] is None
        offline = client.post("/config", json={"model": "x/new:free"}, headers=headers)
        assert offline.status_code == 200
    finally:
        delattr(app.state, "model_catalog")


# --- the machine's mic, speakers and integrations belong to its owner ---


def test_voice_routes_refuse_accounts_other_than_the_owner(client: TestClient) -> None:
    listener = FakeVoiceListener()
    app.state.voice_listener = listener
    try:
        _register(client, "owner@example.com")  # the first account owns the machine
        _, guest = _register(client, "guest@example.com")
        for path in VOICE_ROUTES:
            assert client.post(path, headers=guest).status_code == 403, path
        assert listener.calls == []
    finally:
        delattr(app.state, "voice_listener")


def test_status_reports_machine_integrations_only_to_the_owner(client: TestClient) -> None:
    app.state.voice_listener = FakeVoiceListener()
    try:
        _, owner = _register(client, "owner@example.com")
        _, guest = _register(client, "guest@example.com")
        assert client.get("/status", headers=owner).json()["voice"] is True
        assert client.get("/status", headers=guest).json()["voice"] is False
        assert client.get("/status").json()["voice"] is False
    finally:
        delattr(app.state, "voice_listener")


def test_command_speaks_only_for_the_owner(client: TestClient) -> None:
    tts = FakeTTS()
    app.dependency_overrides[get_tts] = lambda: tts
    _, owner = _register(client, "owner@example.com")
    _, guest = _register(client, "guest@example.com")

    client.post("/command", json={"text": "oi", "speak": True}, headers=guest)
    assert tts.said == []
    client.post("/command", json={"text": "oi", "speak": True}, headers=owner)
    assert tts.said == ["echo: oi"]


def test_long_press_opens_the_mic_instead_of_chatting(client: TestClient, brain: FakeBrain) -> None:
    listener = FakeVoiceListener()
    app.state.voice_listener = listener
    try:
        _, headers = _register(client)
        response = client.post("/wearable/tap", json={"gesture": "long_press"}, headers=headers)
        assert response.status_code == 200
        assert response.json()["reply"] == "Estou ouvindo."
        # The capture runs in the background so the tap returns at once.
        deadline = time.monotonic() + 2.0
        while not listener.calls and time.monotonic() < deadline:
            time.sleep(0.01)
        assert listener.calls == ["once"]
        assert brain.last_user is None  # nothing was sent to the brain as text
    finally:
        delattr(app.state, "voice_listener")


def test_long_press_is_refused_for_other_accounts(client: TestClient) -> None:
    listener = FakeVoiceListener()
    app.state.voice_listener = listener
    try:
        _register(client, "owner@example.com")
        _, guest = _register(client, "guest@example.com")
        response = client.post("/wearable/tap", json={"gesture": "long_press"}, headers=guest)
        assert response.status_code == 403
        assert listener.calls == []
    finally:
        delattr(app.state, "voice_listener")


def test_owner_email_setting_picks_the_owner(client: TestClient, tmp_path: Path) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(
        owner_email="second@example.com", chroma_path=str(tmp_path / "chroma")
    )
    app.state.voice_listener = FakeVoiceListener()
    try:
        _, first = _register(client, "first@example.com")
        _, second = _register(client, "second@example.com")
        assert client.post("/voice/start", headers=first).status_code == 403
        assert client.post("/voice/start", headers=second).status_code == 200
    finally:
        delattr(app.state, "voice_listener")


def test_status_reports_music_control_to_the_owner(client: TestClient) -> None:
    from fear.integrations.music import MediaKeys

    app.state.music = MediaKeys(press=lambda key: None)
    try:
        _, owner = _register(client, "owner@example.com")
        _, guest = _register(client, "guest@example.com")
        assert client.get("/status", headers=owner).json()["music"] is True
        assert client.get("/status", headers=guest).json()["music"] is False
    finally:
        delattr(app.state, "music")


# --- talking to F.E.A.R. through the app (local speech) ---


class FakeEars:
    def __init__(self) -> None:
        self.heard: list[bytes] = []

    def transcribe(self, audio: bytes) -> str:
        self.heard.append(audio)
        return "qual é a próxima reunião?"


class FakeVoice:
    def synthesize(self, text: str, style: str = "natural") -> bytes:
        return b"RIFF" + f"{style}:{text}".encode()


class FakeOnlineVoice:
    """Microsoft's neural voice, answering — or not, like without internet."""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.said: list[tuple[str, str]] = []

    def ready(self) -> bool:
        return True

    async def synthesize(self, text: str, style: str = "natural") -> tuple[bytes, str]:
        self.said.append((text, style))
        if self.fail:
            raise OnlineVoiceError("ConnectionError: no internet")
        return b"ID3" + text.encode(), "audio/mpeg"


def test_voice_routes_need_a_signed_in_user(client: TestClient) -> None:
    assert client.post("/voice/transcribe", content=b"audio").status_code == 401
    assert client.post("/voice/speak", json={"text": "oi"}).status_code == 401


def test_voice_routes_say_when_speech_is_not_installed(client: TestClient) -> None:
    _, headers = _register(client)
    assert client.post("/voice/transcribe", content=b"audio", headers=headers).status_code == 503
    assert client.post("/voice/speak", json={"text": "oi"}, headers=headers).status_code == 503


def test_transcribe_turns_a_recording_into_text(client: TestClient) -> None:
    ears = FakeEars()
    app.state.stt = ears
    try:
        _, headers = _register(client)
        response = client.post(
            "/voice/transcribe",
            content=b"opus-bytes",
            headers={**headers, "content-type": "audio/webm"},
        )
        assert response.json() == {"text": "qual é a próxima reunião?"}
        assert ears.heard == [b"opus-bytes"]
        assert client.post("/voice/transcribe", content=b"", headers=headers).status_code == 422
    finally:
        delattr(app.state, "stt")


def test_speak_returns_a_sentence_as_wav(client: TestClient) -> None:
    app.state.voice_out = FakeVoice()
    try:
        _, headers = _register(client)
        response = client.post(
            "/voice/speak", json={"text": " Olá. ", "style": "natural"}, headers=headers
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/wav"
        assert response.content == "RIFFnatural:Olá.".encode()
        assert client.post("/voice/speak", json={"text": "  "}, headers=headers).status_code == 422
        bad_style = client.post("/voice/speak", json={"text": "oi", "style": "x"}, headers=headers)
        assert bad_style.status_code == 422
    finally:
        delattr(app.state, "voice_out")


def test_speak_uses_the_online_voice_when_it_answers(client: TestClient) -> None:
    app.state.voice_out, app.state.voice_online = FakeVoice(), FakeOnlineVoice()
    try:
        _, headers = _register(client)
        response = client.post("/voice/speak", json={"text": "Olá."}, headers=headers)
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.content == "ID3Olá.".encode()
        assert app.state.voice_online.said == [("Olá.", "natural")]
    finally:
        delattr(app.state, "voice_out")
        delattr(app.state, "voice_online")


def test_speak_falls_back_to_the_local_voice_when_the_online_one_fails(
    client: TestClient,
) -> None:
    app.state.voice_out, app.state.voice_online = FakeVoice(), FakeOnlineVoice(fail=True)
    try:
        _, headers = _register(client)
        response = client.post(
            "/voice/speak", json={"text": "Olá.", "style": "fear"}, headers=headers
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/wav"
        assert response.content == "RIFFfear:Olá.".encode()
    finally:
        delattr(app.state, "voice_out")
        delattr(app.state, "voice_online")


def test_speak_keeps_to_the_local_voice_when_asked(client: TestClient) -> None:
    online = FakeOnlineVoice()
    app.state.voice_out, app.state.voice_online = FakeVoice(), online
    try:
        _, headers = _register(client)
        response = client.post(
            "/voice/speak", json={"text": "Olá.", "online": False}, headers=headers
        )
        assert response.headers["content-type"] == "audio/wav"
        assert online.said == []  # nothing went to Microsoft
    finally:
        delattr(app.state, "voice_out")
        delattr(app.state, "voice_online")


def test_speak_says_so_when_no_voice_can_speak(client: TestClient) -> None:
    app.state.voice_online = FakeOnlineVoice(fail=True)
    try:
        _, headers = _register(client)
        failed = client.post("/voice/speak", json={"text": "Olá."}, headers=headers)
        assert failed.status_code == 503
        # Only the online voice, and it isn't wanted: there's no voice at all.
        local_only = client.post(
            "/voice/speak", json={"text": "Olá.", "online": False}, headers=headers
        )
        assert local_only.status_code == 503
    finally:
        delattr(app.state, "voice_online")


def test_transcribe_refuses_a_recording_too_long_before_reading_it_all(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr(app_module, "_MAX_VOICE_UPLOAD", 1000)
    ears = FakeEars()
    app.state.stt = ears
    try:
        _, headers = _register(client)
        declared = client.post("/voice/transcribe", content=b"x" * 2000, headers=headers)
        # Sent in pieces with no size up front: cut off once past the limit.
        streamed = client.post(
            "/voice/transcribe", content=iter([b"x" * 600, b"x" * 600]), headers=headers
        )
        assert (declared.status_code, streamed.status_code) == (413, 413)
        assert ears.heard == []
    finally:
        delattr(app.state, "stt")


class _SlowVoice:
    """Counts how many sentences are being synthesized at once."""

    def __init__(self) -> None:
        self.active = 0
        self.most = 0
        self.said: list[str] = []

    def synthesize(self, text: str, style: str = "fear") -> bytes:
        self.active += 1
        self.most = max(self.most, self.active)
        time.sleep(0.05)
        self.said.append(text)
        self.active -= 1
        return b"RIFF"


class _Request:
    def __init__(self, voice: _SlowVoice, gone: bool = False) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(voice_out=voice))
        self.gone = gone

    async def is_disconnected(self) -> bool:
        return self.gone


async def _speak(request: _Request, text: str):
    payload = app_module.SpeakRequest(text=text)
    return await app_module.voice_speak(payload, request, object())  # type: ignore[arg-type]


async def test_speak_synthesizes_one_sentence_at_a_time() -> None:
    voice = _SlowVoice()
    request = _Request(voice)
    await asyncio.gather(*(_speak(request, f"Frase {n}.") for n in range(3)))
    assert voice.most == 1  # the rest wait their turn without holding a worker thread
    assert sorted(voice.said) == ["Frase 0.", "Frase 1.", "Frase 2."]


async def test_speak_skips_a_sentence_nobody_waits_for_anymore() -> None:
    voice = _SlowVoice()
    # The reply was interrupted: the page gave up on this sentence while it queued.
    response = await _speak(_Request(voice, gone=True), "Olá.")
    assert response.status_code == 204
    assert voice.said == []


def test_status_reports_voice_in_and_out(client: TestClient) -> None:
    app.state.stt, app.state.voice_out = FakeEars(), FakeVoice()
    try:
        body = client.get("/status").json()
        assert body["voice_input"] is True and body["voice_output"] is True
        assert body["voice_online"] is False
    finally:
        delattr(app.state, "stt")
        delattr(app.state, "voice_out")


def test_status_counts_the_online_voice_as_a_voice(client: TestClient) -> None:
    app.state.voice_online = FakeOnlineVoice()
    try:
        body = client.get("/status").json()
        assert body["voice_output"] is True and body["voice_online"] is True
    finally:
        delattr(app.state, "voice_online")

from __future__ import annotations

import types
from pathlib import Path

import pytest

from fear.brain.async_conversation import AsyncConversationalBrain, UserContext
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemoryResult


class FakeMemory:
    def __init__(self) -> None:
        self.added: list[tuple[str, str, str]] = []
        self.user_ids: list[str] = []

    def get_facts_about_speaker(self, speaker: str, n_results: int = 10, user_id: str = ""):
        return [
            PersonalMemoryResult(
                text="Lucas likes dark, minimal interfaces.",
                speaker=speaker,
                source="conversation",
                timestamp=1.0,
            )
        ]

    def query_memories(
        self, query: str, n_results: int = 5, filter_by_speaker=None, user_id: str = ""
    ):
        return [
            PersonalMemoryResult(
                text="F.E.A.R. should be quiet and direct.",
                speaker=filter_by_speaker or "user",
                source="conversation",
                timestamp=2.0,
            )
        ]

    def add_memory(self, text: str, speaker: str, source: str, user_id: str = "") -> str:
        self.added.append((text, speaker, source))
        self.user_ids.append(user_id)
        return f"fake-{len(self.added)}"


class FakeSpotify:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def handle_intent(self, text: str) -> str:
        self.calls.append(text)
        if "next" in text:
            return "Skipped to the next track."
        return ""


class FakeCalendar:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def handle_intent(self, text: str) -> str:
        self.calls.append(text)
        return "Seus próximos compromissos:\n• 30/06 14:00 — Reunião com o time"


class FakeClient:
    """Minimal stand-in for AsyncOpenAI that records calls and can stream."""

    def __init__(self, reply: str = "ok") -> None:
        self.reply = reply
        self.stream_pieces: list[str] = ["F.E.A.", "R. ", "aqui."]
        self.calls: list[dict] = []

        async def create(*, model, messages, stream=False):
            self.calls.append({"model": model, "messages": messages, "stream": stream})
            if stream:

                async def gen():
                    for piece in self.stream_pieces:
                        delta = types.SimpleNamespace(content=piece)
                        yield types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta)])

                return gen()
            choice = types.SimpleNamespace(message=types.SimpleNamespace(content=self.reply))
            return types.SimpleNamespace(choices=[choice])

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


class FailingClient:
    """An AsyncOpenAI stand-in whose completion calls always raise."""

    def __init__(self) -> None:
        async def create(*, model, messages, **kwargs):
            raise RuntimeError("simulated upstream failure")

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


@pytest.mark.asyncio
async def test_process_command_fallback_without_openrouter() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=memory,  # type: ignore[arg-type]
    )

    result = await brain.process_command("remember this preference", "Lucas")

    assert result.speaker == "Lucas"
    assert result.remembered is True
    assert "OpenRouter is not configured" in result.reply
    assert memory.added == [("remember this preference", "Lucas", "conversation")]


def test_fallback_persona_used_when_no_file() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(persona_file=""),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    message = brain._build_system_message()

    assert "F.E.A.R." in message
    assert "joke" in message  # can banter
    assert "consent-focused" in message  # keeps the guardrail


def test_build_context_includes_memory_sections() -> None:
    brain = AsyncConversationalBrain(settings=Settings(), memory=FakeMemory())  # type: ignore[arg-type]

    context = brain._build_context(
        speaker_name="Lucas",
        speaker_facts=[
            PersonalMemoryResult(
                text="Lucas likes calm tools.",
                speaker="Lucas",
                source="voice",
                timestamp=1.0,
            )
        ],
        related_memories=[],
        general_memories=[],
        reference_context="- local note",
    )

    assert "Current speaker: Lucas" in context
    assert "Lucas likes calm tools." in context
    assert "Local reference notes" in context
    assert "- local note" in context


@pytest.mark.asyncio
async def test_music_command_routes_to_spotify() -> None:
    memory = FakeMemory()
    spotify = FakeSpotify()
    brain = AsyncConversationalBrain(
        settings=Settings(),
        memory=memory,
        spotify=spotify,  # type: ignore[arg-type]
    )

    result = await brain.process_command("next Spotify song", "Lucas")

    assert result.reply == "Skipped to the next track."
    assert result.remembered is True
    assert spotify.calls == ["next spotify song"]
    assert memory.added == [("next Spotify song", "Lucas", "spotify")]


@pytest.mark.asyncio
async def test_calendar_command_routes_to_calendar() -> None:
    memory = FakeMemory()
    calendar = FakeCalendar()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=memory,
        calendar=calendar,  # type: ignore[arg-type]
    )

    result = await brain.process_command("o que tem na minha agenda hoje?", "Lucas")

    assert "compromissos" in result.reply.lower()
    assert calendar.calls == ["o que tem na minha agenda hoje?"]
    assert memory.added == [("o que tem na minha agenda hoje?", "Lucas", "calendar")]


@pytest.mark.asyncio
async def test_calendar_is_phrased_by_the_model_when_available() -> None:
    calendar = FakeCalendar()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),
        calendar=calendar,  # type: ignore[arg-type]
    )
    fake = FakeClient(reply="Você tem um compromisso hoje. Não desperdice.")
    brain.client = fake  # type: ignore[assignment]

    result = await brain.process_command("o que tem na minha agenda?", "Lucas")

    # F.E.A.R. speaks (the model's reply); the raw events are handed to it as context.
    assert result.reply == "Você tem um compromisso hoje. Não desperdice."
    system_content = fake.calls[0]["messages"][0]["content"]
    assert "Reunião com o time" in system_content


@pytest.mark.asyncio
async def test_non_calendar_command_does_not_touch_calendar() -> None:
    calendar = FakeCalendar()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=FakeMemory(),
        calendar=calendar,  # type: ignore[arg-type]
    )

    await brain.process_command("como você está hoje?", "Lucas")

    assert calendar.calls == []


@pytest.mark.asyncio
async def test_non_music_command_does_not_touch_spotify() -> None:
    memory = FakeMemory()
    spotify = FakeSpotify()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=memory,
        spotify=spotify,  # type: ignore[arg-type]
    )

    result = await brain.process_command("how are you today", "Lucas")

    assert spotify.calls == []
    assert "OpenRouter is not configured" in result.reply
    assert memory.added == [("how are you today", "Lucas", "conversation")]


@pytest.mark.asyncio
async def test_conversation_keeps_recent_history() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    fake = FakeClient(reply="primeira resposta")
    brain.client = fake  # type: ignore[assignment]

    await brain.process_command("oi, guarda meu nome: Lucas", "Lucas")
    fake.reply = "segunda resposta"
    await brain.process_command("qual meu nome?", "Lucas")

    # The second call must carry the first exchange as prior context.
    second_messages = fake.calls[1]["messages"]
    assert second_messages[0]["role"] == "system"
    assert "F.E.A.R." in second_messages[0]["content"]

    pairs = [(m["role"], m["content"]) for m in second_messages]
    assert ("user", "oi, guarda meu nome: Lucas") in pairs
    assert ("assistant", "primeira resposta") in pairs
    assert second_messages[-1] == {"role": "user", "content": "qual meu nome?"}


@pytest.mark.asyncio
async def test_history_window_is_capped() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", max_history_turns=2),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = FakeClient(reply="r")  # type: ignore[assignment]

    for index in range(3):
        await brain.process_command(f"mensagem {index}", "Lucas")

    assert len(brain._history["Lucas"]) <= 2


def test_persona_file_overrides_default(tmp_path) -> None:
    persona_path = tmp_path / "persona.md"
    persona_path.write_text("You are a playful JARVIS-style companion.", encoding="utf-8")

    brain = AsyncConversationalBrain(
        settings=Settings(persona_file=str(persona_path)),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    assert brain._build_system_message() == "You are a playful JARVIS-style companion."


@pytest.mark.asyncio
async def test_stream_command_streams_and_records() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=memory,  # type: ignore[arg-type]
    )
    fake = FakeClient()
    fake.stream_pieces = ["Olá", ", ", "Lucas."]
    brain.client = fake  # type: ignore[assignment]

    chunks = [chunk async for chunk in brain.stream_command("oi", "Lucas")]

    assert chunks == ["Olá", ", ", "Lucas."]
    assert fake.calls[0]["stream"] is True
    # User input and the assembled reply are both persisted; the turn is recorded.
    assert ("oi", "Lucas", "conversation") in memory.added
    assert ("Olá, Lucas.", "fear", "assistant_reply") in memory.added
    assert brain._history["Lucas"][-1] == {"role": "assistant", "content": "Olá, Lucas."}


@pytest.mark.asyncio
async def test_stream_command_fallback_without_openrouter() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(settings=Settings(), memory=memory)  # type: ignore[arg-type]

    chunks = [chunk async for chunk in brain.stream_command("oi", "Lucas")]

    assert len(chunks) == 1
    assert "OpenRouter is not configured" in chunks[0]
    assert memory.added == [("oi", "Lucas", "conversation")]


def test_default_persona_is_the_shipped_council() -> None:
    persona_path = Path(__file__).resolve().parents[1] / "prompts" / "fear_persona.md"
    assert persona_path.exists(), "prompts/fear_persona.md should ship with the repo"

    # Settings() defaults persona_file to the shipped persona, and it must load
    # regardless of the current working directory.
    brain = AsyncConversationalBrain(
        settings=Settings(persona_file="prompts/fear_persona.md"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    message = brain._build_system_message()
    assert "F.E.A.R." in message
    assert "Chairman" in message  # the six-voice council
    assert "Ultron" in message  # the flavor


@pytest.mark.asyncio
async def test_general_memories_exclude_fear_replies() -> None:
    class EchoMemory(FakeMemory):
        def query_memories(
            self, query: str, n_results: int = 5, filter_by_speaker=None, user_id: str = ""
        ):
            if filter_by_speaker is None:
                return [
                    PersonalMemoryResult(
                        text="algo que o usuario disse",
                        speaker="Lucas",
                        source="conversation",
                        timestamp=1.0,
                    ),
                    PersonalMemoryResult(
                        text="algo que a propria FEAR respondeu",
                        speaker="fear",
                        source="assistant_reply",
                        timestamp=2.0,
                    ),
                ]
            return []

    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=EchoMemory(),  # type: ignore[arg-type]
    )
    fake = FakeClient()
    brain.client = fake  # type: ignore[assignment]

    await brain.process_command("e aí", "Lucas")

    system_content = fake.calls[0]["messages"][0]["content"]
    assert "algo que o usuario disse" in system_content
    # F.E.A.R.'s own prior reply must not be fed back as cross-speaker context.
    assert "algo que a propria FEAR respondeu" not in system_content


@pytest.mark.asyncio
async def test_user_context_uses_own_key_model_and_memory_scope() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="global-model"),
        memory=memory,  # type: ignore[arg-type]
    )
    brain.client = FakeClient(reply="anon")  # the shared/anonymous client
    user_client = FakeClient(reply="user-specific")
    brain._clients_by_key["user-key"] = user_client  # seed the per-user client (BYO key)

    ctx = UserContext(user_id="u1", api_key="user-key", chat_model="user-model")
    result = await brain.process_command("oi", "Lucas", user=ctx)

    assert result.reply == "user-specific"  # used the user's own client, not the shared one
    assert user_client.calls[0]["model"] == "user-model"  # and the user's own model
    # Every memory write is tagged with the user's id, isolating their memory.
    assert memory.user_ids and all(uid == "u1" for uid in memory.user_ids)


@pytest.mark.asyncio
async def test_logged_in_without_key_is_prompted_to_add_one() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),  # no shared client either
        memory=memory,  # type: ignore[arg-type]
    )

    # A signed-in user who hasn't added their key gets an in-voice nudge, not the
    # env-var message meant for local single-user setup.
    result = await brain.process_command("oi", "Lucas", user=UserContext(user_id="u1"))

    assert "chave" in result.reply.lower()
    assert "OPENROUTER_API_KEY" not in result.reply
    assert result.remembered is True
    assert memory.user_ids == ["u1"]  # still saved, scoped to the user


@pytest.mark.asyncio
async def test_user_history_is_keyed_by_user_not_speaker() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = FakeClient(reply="r")  # no api_key on the context -> shared client

    await brain.process_command("lembra disso", "Lucas", user=UserContext(user_id="u1"))

    assert "u1" in brain._history  # history is isolated under the user id
    assert "Lucas" not in brain._history


@pytest.mark.asyncio
async def test_anonymous_command_is_unchanged_by_multiuser() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=memory,  # type: ignore[arg-type]
    )
    brain.client = FakeClient(reply="r")

    await brain.process_command("oi", "Lucas")  # no user -> single-user path

    assert "Lucas" in brain._history  # keyed by speaker, as before
    # Both writes (user input + assistant reply) carry an empty (unscoped) user id.
    assert memory.user_ids == ["", ""]


@pytest.mark.asyncio
async def test_process_command_survives_llm_failure() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=memory,  # type: ignore[arg-type]
    )
    brain.client = FailingClient()  # type: ignore[assignment]

    result = await brain.process_command("oi", "Lucas")

    assert result.remembered is True
    assert "problema" in result.reply.lower()  # graceful fallback, not a crash
    # The user input is kept; the error reply is not stored as an assistant memory.
    assert ("oi", "Lucas", "conversation") in memory.added
    assert all(source != "assistant_reply" for (_, _, source) in memory.added)


@pytest.mark.asyncio
async def test_stream_command_survives_llm_failure() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = FailingClient()  # type: ignore[assignment]

    chunks = [chunk async for chunk in brain.stream_command("oi", "Lucas")]

    assert any("problema" in chunk.lower() for chunk in chunks)


# --- item 3: LRU-bounded caches ---


def test_history_cache_is_lru_bounded(monkeypatch) -> None:
    monkeypatch.setattr("fear.brain.async_conversation._MAX_HISTORY_USERS", 3)
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", max_history_turns=4),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    for index in range(5):
        brain._record_turn(f"user{index}", "oi", "resposta")

    assert len(brain._history) == 3
    assert "user4" in brain._history and "user3" in brain._history
    assert "user0" not in brain._history  # least-recently-used evicted


def test_history_access_promotes_to_most_recent(monkeypatch) -> None:
    monkeypatch.setattr("fear.brain.async_conversation._MAX_HISTORY_USERS", 3)
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", max_history_turns=4),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    for index in range(3):
        brain._record_turn(f"user{index}", "oi", "resposta")
    brain._history_for("user0")  # touching the oldest promotes it
    brain._record_turn("user3", "oi", "resposta")  # triggers one eviction

    assert "user0" in brain._history  # promoted — survived
    assert "user1" not in brain._history  # became the oldest — evicted


def test_reset_conversation_removes_history() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain._record_turn("Lucas", "oi", "resposta")
    assert "Lucas" in brain._history

    brain.reset_conversation("Lucas")
    assert "Lucas" not in brain._history


def test_client_cache_is_lru_bounded(monkeypatch) -> None:
    monkeypatch.setattr("fear.brain.async_conversation._MAX_CLIENTS", 2)
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    brain._client_for(UserContext(user_id="a", api_key="k1"))
    brain._client_for(UserContext(user_id="b", api_key="k2"))
    brain._client_for(UserContext(user_id="c", api_key="k3"))  # evicts k1 (LRU)

    assert len(brain._clients_by_key) == 2
    assert "k1" not in brain._clients_by_key
    assert "k3" in brain._clients_by_key

from __future__ import annotations

import types
from pathlib import Path

import httpx
import openai
import pytest

from fear.attention import VISUAL_ATTENTION_DIRECTIVE, VisualAttention
from fear.brain.async_conversation import AsyncConversationalBrain, UserContext
from fear.brain.local_models import LocalModelError
from fear.brain.models import FALLBACK_MODELS
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


def _attention(captured_at_ms: float = 100_000.0) -> VisualAttention:
    return VisualAttention(
        source="pointer-test",
        coordinate_space="viewport-css-pixels",
        x=100,
        y=150,
        viewport_width=640,
        viewport_height=480,
        captured_at_ms=captured_at_ms,
        calibration_error_px=25,
        target={"label": "Vídeo", "text": "PRIVATE_VIEWPORT_CONTENT", "role": "video"},
    )


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.asyncio
async def test_attention_is_untrusted_context_for_one_turn_and_not_persisted(
    monkeypatch: pytest.MonkeyPatch, streaming: bool
) -> None:
    monkeypatch.setattr("fear.attention.time.time", lambda: 100.0)
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", ollama_url=""),
        memory=memory,  # type: ignore[arg-type]
    )
    fake = FakeClient(reply="resposta")
    brain.client = fake  # type: ignore[assignment]
    user = UserContext(user_id="u1")
    if streaming:
        session = await brain.open_stream("o que é isso?", "Lucas", user, visual_attention=_attention())
        reply = "".join([chunk async for chunk in session.stream])
    else:
        result = await brain.process_command(
            "o que é isso?", "Lucas", user, visual_attention=_attention()
        )
        reply = result.reply

    messages = fake.calls[0]["messages"]
    assert VISUAL_ATTENTION_DIRECTIVE in messages[0]["content"]
    assert "PRIVATE_VIEWPORT_CONTENT" not in messages[0]["content"]
    assert messages[-2]["role"] == "user"
    assert "untrusted JSON data" in messages[-2]["content"]
    assert "PRIVATE_VIEWPORT_CONTENT" in messages[-2]["content"]
    assert messages[-1] == {"role": "user", "content": "o que é isso?"}
    assert memory.added == [("o que é isso?", "Lucas", "conversation")]
    assert memory.user_ids == ["u1"]
    assert brain._history["u1"][-1] == {"role": "assistant", "content": reply}
    assert all("PRIVATE_VIEWPORT_CONTENT" not in item["content"] for item in brain._history["u1"])

    # A later turn (same account) and another account receive no raw snapshot.
    await brain.process_command("continue", "Lucas", user)
    await brain.process_command("oi", "Ana", UserContext(user_id="u2"))
    for call in fake.calls[1:]:
        assert not any("PRIVATE_VIEWPORT_CONTENT" in item["content"] for item in call["messages"])
        assert VISUAL_ATTENTION_DIRECTIVE not in call["messages"][0]["content"]
    assert any(source == "assistant_reply" for _, _, source in memory.added)


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("captured_at_ms", [89_999.0, 110_001.0])
@pytest.mark.asyncio
async def test_attention_stale_or_future_keeps_ordinary_conversation(
    monkeypatch: pytest.MonkeyPatch, streaming: bool, captured_at_ms: float
) -> None:
    monkeypatch.setattr("fear.attention.time.time", lambda: 100.0)
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", ollama_url=""),
        memory=memory,  # type: ignore[arg-type]
    )
    fake = FakeClient(reply="resposta")
    brain.client = fake  # type: ignore[assignment]
    if streaming:
        session = await brain.open_stream("oi", visual_attention=_attention(captured_at_ms))
        _ = [chunk async for chunk in session.stream]
    else:
        await brain.process_command("oi", visual_attention=_attention(captured_at_ms))
    messages = fake.calls[0]["messages"]
    assert len(messages) == 2
    assert VISUAL_ATTENTION_DIRECTIVE not in messages[0]["content"]
    assert any(source == "assistant_reply" for _, _, source in memory.added)


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.asyncio
async def test_attention_expiring_during_context_lookup_is_not_sent(
    monkeypatch: pytest.MonkeyPatch, streaming: bool
) -> None:
    clock = [100.0]
    monkeypatch.setattr("fear.attention.time.time", lambda: clock[0])
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", ollama_url=""),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    fake = FakeClient()
    brain.client = fake  # type: ignore[assignment]
    original = brain._gather_context

    async def slow_context(*args):
        context = await original(*args)
        clock[0] = 111.0
        return context

    monkeypatch.setattr(brain, "_gather_context", slow_context)
    if streaming:
        session = await brain.open_stream("oi", visual_attention=_attention())
        _ = [chunk async for chunk in session.stream]
    else:
        await brain.process_command("oi", visual_attention=_attention())
    assert len(fake.calls[0]["messages"]) == 2


def test_build_messages_rechecks_attention_freshness(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("fear.attention.time.time", lambda: 111.0)
    brain = AsyncConversationalBrain(settings=Settings(), memory=FakeMemory())  # type: ignore[arg-type]
    messages = brain._build_messages("Lucas", "oi", [], [], [], "", visual_attention=_attention())
    assert len(messages) == 2
    assert VISUAL_ATTENTION_DIRECTIVE not in messages[0]["content"]


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
        music=spotify,  # type: ignore[arg-type]
    )

    result = await brain.process_command("next Spotify song", "Lucas")

    assert result.reply == "Skipped to the next track."
    assert result.remembered is True
    assert spotify.calls == ["next spotify song"]
    assert memory.added == [("next Spotify song", "Lucas", "music")]


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
        music=spotify,  # type: ignore[arg-type]
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

    # A "turn" is a user message plus its reply, so 2 turns == 4 stored messages.
    window = brain._history["Lucas"]
    assert len(window) == 4
    assert [entry["content"] for entry in window] == ["mensagem 1", "r", "mensagem 2", "r"]


@pytest.mark.asyncio
async def test_history_keeps_the_configured_number_of_turns() -> None:
    # The setting is named (and documented as) turns: asking for 3 must keep the
    # last 3 exchanges, not half of them.
    turns = 3
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m", max_history_turns=turns),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = FakeClient(reply="r")  # type: ignore[assignment]

    for index in range(6):
        await brain.process_command(f"m{index}", "Lucas")

    window = brain._history["Lucas"]
    user_messages = [entry["content"] for entry in window if entry["role"] == "user"]
    assert user_messages == ["m3", "m4", "m5"]  # the 3 most recent turns survive


def test_persona_file_overrides_default(tmp_path) -> None:
    persona_path = tmp_path / "persona.md"
    persona_path.write_text("You are a playful JARVIS-style companion.", encoding="utf-8")

    brain = AsyncConversationalBrain(
        settings=Settings(persona_file=str(persona_path)),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )

    assert brain._build_system_message() == "You are a playful JARVIS-style companion."


@pytest.mark.asyncio
async def test_open_stream_streams_and_records() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=memory,  # type: ignore[arg-type]
    )
    fake = FakeClient()
    fake.stream_pieces = ["Olá", ", ", "Lucas."]
    brain.client = fake  # type: ignore[assignment]

    chunks = [chunk async for chunk in (await brain.open_stream("oi", "Lucas")).stream]

    assert chunks == ["Olá", ", ", "Lucas."]
    assert fake.calls[0]["stream"] is True
    # User input and the assembled reply are both persisted; the turn is recorded.
    assert ("oi", "Lucas", "conversation") in memory.added
    assert ("Olá, Lucas.", "fear", "assistant_reply") in memory.added
    assert brain._history["Lucas"][-1] == {"role": "assistant", "content": "Olá, Lucas."}


@pytest.mark.asyncio
async def test_open_stream_fallback_without_openrouter() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(settings=Settings(), memory=memory)  # type: ignore[arg-type]

    chunks = [chunk async for chunk in (await brain.open_stream("oi", "Lucas")).stream]

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
async def test_open_stream_survives_llm_failure() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = FailingClient()  # type: ignore[assignment]

    chunks = [chunk async for chunk in (await brain.open_stream("oi", "Lucas")).stream]

    assert any("problema" in chunk.lower() for chunk in chunks)


# --- PR #22: consulted-memory ids exposed by open_stream ---


def test_consulted_ids_dedups_and_preserves_order() -> None:
    def mem(mid: str) -> PersonalMemoryResult:
        return PersonalMemoryResult(text="", speaker="", source="", timestamp=0.0, id=mid)

    related = [mem("a"), mem("b")]
    general = [mem("b"), mem("c"), mem("")]  # a dup and an id-less entry

    assert AsyncConversationalBrain._consulted_ids(related, general) == ["a", "b", "c"]


class IdMemory(FakeMemory):
    """Returns memories WITH ids so consulted-id reporting can be asserted."""

    def get_facts_about_speaker(self, speaker: str, n_results: int = 10, user_id: str = ""):
        return [
            PersonalMemoryResult(
                text="fato recente", speaker=speaker, source="voice", timestamp=1.0, id="fact-1"
            )
        ]

    def query_memories(
        self, query: str, n_results: int = 5, filter_by_speaker=None, user_id: str = ""
    ):
        if filter_by_speaker is None:
            return [
                PersonalMemoryResult(
                    text="geral",
                    speaker="Lucas",
                    source="conversation",
                    timestamp=2.0,
                    id="general-1",
                )
            ]
        return [
            PersonalMemoryResult(
                text="relacionada",
                speaker=filter_by_speaker,
                source="conversation",
                timestamp=3.0,
                id="related-1",
            )
        ]


@pytest.mark.asyncio
async def test_open_stream_reports_related_and_general_not_speaker_facts() -> None:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=IdMemory(),  # type: ignore[arg-type]
    )
    brain.client = FakeClient()  # type: ignore[assignment]

    session = await brain.open_stream("oi", "Lucas")
    chunks = [chunk async for chunk in session.stream]

    # related + general are reported; the ambient speaker fact is not.
    assert session.consulted_memory_ids == ["related-1", "general-1"]
    assert "fact-1" not in session.consulted_memory_ids
    # The token body is exactly what the stream would produce otherwise.
    assert "".join(chunks) == "F.E.A.R. aqui."


@pytest.mark.asyncio
async def test_open_stream_reports_consulted_ids_even_without_model() -> None:
    # No OpenRouter -> a fallback body, but the gather still ran, so the consulted
    # ids are known and reported (the header works even on the fallback path).
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=IdMemory(),  # type: ignore[arg-type]
    )

    session = await brain.open_stream("oi", "Lucas")
    chunks = [chunk async for chunk in session.stream]

    assert session.consulted_memory_ids == ["related-1", "general-1"]
    assert len(chunks) == 1  # single fallback chunk
    assert "OpenRouter is not configured" in chunks[0]


@pytest.mark.asyncio
async def test_open_stream_has_no_consulted_ids_for_spotify_shortcut() -> None:
    # The Spotify shortcut returns before any memory gather, so nothing is consulted.
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=IdMemory(),  # type: ignore[arg-type]
        music=FakeSpotify(),  # type: ignore[arg-type]
    )

    session = await brain.open_stream("next Spotify song", "Lucas")
    chunks = [chunk async for chunk in session.stream]

    assert session.consulted_memory_ids == []
    assert chunks == ["Skipped to the next track."]


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


# --- the machine's integrations belong to its owner ---------------------------


@pytest.mark.asyncio
async def test_other_accounts_cannot_drive_the_owners_spotify() -> None:
    spotify = FakeSpotify()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=FakeMemory(),  # type: ignore[arg-type]
        music=spotify,  # type: ignore[arg-type]
    )

    await brain.process_command("next song on spotify", "Ana", user=UserContext(user_id="ana"))
    await brain.open_stream("next song on spotify", "Ana", user=UserContext(user_id="ana"))

    assert spotify.calls == []


@pytest.mark.asyncio
async def test_other_accounts_cannot_read_the_owners_calendar() -> None:
    calendar = FakeCalendar()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=FakeMemory(),  # type: ignore[arg-type]
        calendar=calendar,  # type: ignore[arg-type]
    )

    result = await brain.process_command("minha agenda", "Ana", user=UserContext(user_id="ana"))

    assert calendar.calls == []
    assert "Reunião" not in result.reply


@pytest.mark.asyncio
async def test_the_owner_still_reaches_spotify_and_calendar() -> None:
    spotify, calendar = FakeSpotify(), FakeCalendar()
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key=""),
        memory=FakeMemory(),  # type: ignore[arg-type]
        music=spotify,  # type: ignore[arg-type]
        calendar=calendar,  # type: ignore[arg-type]
    )
    owner = UserContext(user_id="lucas", is_owner=True)

    music = await brain.process_command("next song on spotify", "Lucas", user=owner)
    agenda = await brain.process_command("minha agenda", "Lucas", user=owner)

    assert music.reply == "Skipped to the next track."
    assert "Reunião" in agenda.reply


@pytest.mark.asyncio
async def test_stream_skips_chunks_without_choices() -> None:
    # OpenRouter sends keep-alive / usage chunks with an empty `choices` list;
    # indexing them used to raise and cut the reply after the first piece.
    client = FakeClient()

    async def create(*, model, messages, stream=False):
        async def gen():
            for piece in ["F.E.A.", None, "R."]:
                if piece is None:
                    yield types.SimpleNamespace(choices=[])
                    continue
                delta = types.SimpleNamespace(content=piece)
                yield types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta)])

        return gen()

    client.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="m"),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = client  # type: ignore[assignment]

    chunks = [chunk async for chunk in (await brain.open_stream("oi", "Lucas")).stream]

    assert "".join(chunks) == "F.E.A.R."


# --- OpenRouter retiring or refusing a model ---

_REQUEST = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")


def _openrouter_error(error_class: type[openai.APIStatusError], status: int, message: str):
    return error_class(message, response=httpx.Response(status, request=_REQUEST), body=None)


class ModelsClient:
    """An AsyncOpenAI stand-in where each model answers, fails or says nothing."""

    def __init__(self, outcomes: dict[str, Exception | str]) -> None:
        self.tried: list[str] = []

        async def create(*, model, messages, stream=False):
            self.tried.append(model)
            outcome = outcomes.get(model, "Aqui é o F.E.A.R.")
            if isinstance(outcome, Exception):
                raise outcome
            if stream:

                async def gen():
                    if outcome:
                        delta = types.SimpleNamespace(content=outcome)
                        yield types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta)])

                return gen()
            message = types.SimpleNamespace(content=outcome)
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=message)])

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


def _brain(client: ModelsClient, memory: FakeMemory | None = None) -> AsyncConversationalBrain:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_chat_model="gone/model:free"),
        memory=memory or FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = client  # type: ignore[assignment]
    return brain


async def _streamed(brain: AsyncConversationalBrain, text: str = "oi") -> str:
    return "".join([chunk async for chunk in (await brain.open_stream(text, "Lucas")).stream])


GONE = _openrouter_error(openai.NotFoundError, 404, "No endpoints found for gone/model:free.")


@pytest.mark.asyncio
async def test_a_retired_model_hands_the_reply_to_the_next_one() -> None:
    client = ModelsClient({"gone/model:free": GONE})
    brain = _brain(client)

    result = await brain.process_command("oi", "Lucas")
    streamed = await _streamed(brain)

    assert result.reply == "Aqui é o F.E.A.R."
    assert streamed == "Aqui é o F.E.A.R."
    # Tried once, then left out: the second reply doesn't wait on it.
    assert client.tried == ["gone/model:free", FALLBACK_MODELS[0], FALLBACK_MODELS[0]]


@pytest.mark.asyncio
async def test_a_refused_key_is_said_plainly_and_no_other_model_is_tried() -> None:
    memory = FakeMemory()
    refused = _openrouter_error(openai.AuthenticationError, 401, "No auth credentials found")
    client = ModelsClient({"gone/model:free": refused})
    brain = _brain(client, memory)

    result = await brain.process_command("oi", "Lucas")

    assert "recusou a sua chave" in result.reply
    assert client.tried == ["gone/model:free"]
    assert all(source != "assistant_reply" for (_, _, source) in memory.added)


@pytest.mark.asyncio
async def test_the_end_of_the_free_quota_is_explained() -> None:
    quota = _openrouter_error(
        openai.RateLimitError, 429, "Rate limit exceeded: free-models-per-day. Add 10 credits"
    )
    client = ModelsClient({"gone/model:free": quota})

    reply = await _streamed(_brain(client))

    assert "cota de hoje" in reply
    assert client.tried == ["gone/model:free"]  # every free model shares that quota


@pytest.mark.asyncio
async def test_a_privacy_setting_blocking_free_models_is_explained() -> None:
    policy = _openrouter_error(
        openai.NotFoundError, 404, "No endpoints found matching your data policy"
    )
    reply = await _streamed(_brain(ModelsClient({"gone/model:free": policy})))
    assert "openrouter.ai/settings/privacy" in reply


@pytest.mark.asyncio
async def test_an_empty_reply_counts_as_no_reply() -> None:
    client = ModelsClient({"gone/model:free": ""})
    result = await _brain(client).process_command("oi", "Lucas")
    assert result.reply == "Aqui é o F.E.A.R."
    assert client.tried == ["gone/model:free", FALLBACK_MODELS[0]]


@pytest.mark.asyncio
async def test_when_no_model_answers_it_says_why() -> None:
    client = ModelsClient({model: GONE for model in ["gone/model:free", *FALLBACK_MODELS]})
    reply = await _streamed(_brain(client))
    assert "gone/model:free não está disponível" in reply
    assert client.tried == ["gone/model:free", *FALLBACK_MODELS]


# --- thinking on this computer (Ollama) ---


class LocalModelsClient(ModelsClient):
    """Ollama on this computer, as the brain sees it: what it has, and its replies."""

    def __init__(
        self, outcomes: dict[str, Exception | str], tags: tuple[str, ...] = ("qwen3.5:4b",)
    ):
        super().__init__(outcomes)
        self.tags = tags

    async def chat_models(self):
        return [types.SimpleNamespace(tag=tag) for tag in self.tags]


LOCAL = "ollama/qwen3.5:4b"
OLLAMA_CLOSED = LocalModelError("down", "O Ollama não está aberto.")


def _local_brain(
    model: str, cloud: ModelsClient | None, local: LocalModelsClient | None
) -> AsyncConversationalBrain:
    brain = AsyncConversationalBrain(
        settings=Settings(openrouter_api_key="", openrouter_chat_model=model),
        memory=FakeMemory(),  # type: ignore[arg-type]
    )
    brain.client = cloud  # type: ignore[assignment]
    brain._local = local  # type: ignore[assignment]
    return brain


@pytest.mark.asyncio
async def test_without_a_key_it_thinks_on_this_computer() -> None:
    local = LocalModelsClient({})
    brain = _local_brain("thinkingmachines/inkling:free", None, local)

    reply = await _streamed(brain)

    assert reply == "Aqui é o F.E.A.R."
    assert local.tried == [LOCAL]  # the recommended model, the one downloaded


@pytest.mark.asyncio
async def test_a_local_model_chosen_gives_way_to_the_cloud_when_ollama_is_closed() -> None:
    cloud, local = ModelsClient({}), LocalModelsClient({LOCAL: OLLAMA_CLOSED})
    brain = _local_brain(LOCAL, cloud, local)

    result = await brain.process_command("oi", "Lucas")

    assert result.reply == "Aqui é o F.E.A.R."
    assert local.tried == [LOCAL]
    assert cloud.tried == [FALLBACK_MODELS[0]]


@pytest.mark.asyncio
async def test_ollama_closed_with_no_cloud_to_fall_back_on_is_said_plainly() -> None:
    reply = await _streamed(_local_brain(LOCAL, None, LocalModelsClient({LOCAL: OLLAMA_CLOSED})))
    assert "O Ollama não está aberto" in reply
    assert "qwen3.5:4b" in reply


@pytest.mark.asyncio
async def test_when_the_free_cloud_runs_out_the_model_on_this_computer_answers() -> None:
    quota = _openrouter_error(
        openai.RateLimitError, 429, "Rate limit exceeded: free-models-per-day. Add 10 credits"
    )
    cloud = ModelsClient({"gone/model:free": quota})
    local = LocalModelsClient({})
    brain = _local_brain("gone/model:free", cloud, local)

    reply = await _streamed(brain)

    assert reply == "Aqui é o F.E.A.R."
    assert cloud.tried == ["gone/model:free"]  # the quota holds for every free model
    assert local.tried == [LOCAL]


@pytest.mark.asyncio
async def test_with_no_way_to_think_it_says_how_to_get_one() -> None:
    brain = _local_brain("thinkingmachines/inkling:free", None, LocalModelsClient({}, tags=()))
    user = UserContext(user_id="u1")

    result = await brain.process_command("oi", "Lucas", user=user)

    assert "chave do OpenRouter" in result.reply
    assert "no seu PC" in result.reply

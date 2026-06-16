from __future__ import annotations

import types
from pathlib import Path

import pytest

from fear.brain.async_conversation import AsyncConversationalBrain
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemoryResult


class FakeMemory:
    def __init__(self) -> None:
        self.added: list[tuple[str, str, str]] = []

    def get_facts_about_speaker(self, speaker: str, n_results: int = 10):
        return [
            PersonalMemoryResult(
                text="Lucas likes dark, minimal interfaces.",
                speaker=speaker,
                source="conversation",
                timestamp=1.0,
            )
        ]

    def query_memories(self, query: str, n_results: int = 5, filter_by_speaker=None):
        return [
            PersonalMemoryResult(
                text="F.E.A.R. should be quiet and direct.",
                speaker=filter_by_speaker or "user",
                source="conversation",
                timestamp=2.0,
            )
        ]

    def add_memory(self, text: str, speaker: str, source: str) -> str:
        self.added.append((text, speaker, source))
        return f"fake-{len(self.added)}"


class FakeSpotify:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def handle_intent(self, text: str) -> str:
        self.calls.append(text)
        if "next" in text:
            return "Skipped to the next track."
        return ""


class FakeClient:
    """Minimal stand-in for AsyncOpenAI that records the messages it receives."""

    def __init__(self, reply: str = "ok") -> None:
        self.reply = reply
        self.calls: list[dict] = []

        async def create(*, model, messages):
            self.calls.append({"model": model, "messages": messages})
            choice = types.SimpleNamespace(message=types.SimpleNamespace(content=self.reply))
            return types.SimpleNamespace(choices=[choice])

        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=create))


@pytest.mark.asyncio
async def test_process_command_fallback_without_openrouter() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(settings=Settings(), memory=memory)  # type: ignore[arg-type]

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
async def test_non_music_command_does_not_touch_spotify() -> None:
    memory = FakeMemory()
    spotify = FakeSpotify()
    brain = AsyncConversationalBrain(
        settings=Settings(),
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


def test_default_persona_is_the_shipped_council() -> None:
    persona_path = Path(__file__).resolve().parents[1] / "prompts" / "fear_persona.md"
    assert persona_path.exists(), "prompts/fear_persona.md should ship with the repo"

    # Settings() defaults persona_file to the shipped persona, and it must load
    # regardless of the current working directory.
    brain = AsyncConversationalBrain(settings=Settings(), memory=FakeMemory())  # type: ignore[arg-type]

    message = brain._build_system_message()
    assert "F.E.A.R." in message
    assert "Chairman" in message  # the six-voice council
    assert "Ultron" in message  # the flavor

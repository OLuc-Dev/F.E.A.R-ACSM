from __future__ import annotations

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


@pytest.mark.asyncio
async def test_process_command_fallback_without_openrouter() -> None:
    memory = FakeMemory()
    brain = AsyncConversationalBrain(settings=Settings(), memory=memory)  # type: ignore[arg-type]

    result = await brain.process_command("remember this preference", "Lucas")

    assert result.speaker == "Lucas"
    assert result.remembered is True
    assert "OpenRouter is not configured" in result.reply
    assert memory.added == [("remember this preference", "Lucas", "conversation")]


def test_build_system_message_preserves_persona() -> None:
    brain = AsyncConversationalBrain(settings=Settings(), memory=FakeMemory())  # type: ignore[arg-type]

    message = brain._build_system_message()

    assert "F.E.A.R." in message
    assert "quiet" in message
    assert "empathetic" in message
    assert "consent-focused" in message


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

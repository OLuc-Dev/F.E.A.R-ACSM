from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from openai import AsyncOpenAI

from fear.config import Settings
from fear.library.reference_library import ReferenceLibrary
from fear.memory.personal_memory import PersonalMemory, PersonalMemoryResult


@dataclass(slots=True)
class CommandResponse:
    """Result of one conversational command."""

    reply: str
    speaker: str
    remembered: bool


class ConversationalBrain:
    """
    Conversational layer for F.E.A.R. with personal memory and local references.

    OpenRouter is used through the OpenAI-compatible client. The reference
    library is intended for user-owned notes and summaries, not bundled book text.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        memory: PersonalMemory,
        reference_library: Optional[ReferenceLibrary] = None,
    ) -> None:
        self.settings = settings
        self.memory = memory
        self.reference_library = reference_library
        self.client: Optional[AsyncOpenAI] = None

        if settings.openrouter_api_key:
            self.client = AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                default_headers={
                    "HTTP-Referer": settings.openrouter_http_referer,
                    "X-Title": settings.openrouter_app_title,
                },
            )

    async def process_command(self, user_text: str, speaker_name: str = "user") -> CommandResponse:
        """
        Process a user command with memory-aware context.

        The assistant retrieves facts about the speaker, searches related
        memories, optionally retrieves local reference notes, then calls the
        configured OpenRouter chat model.
        """
        clean_text = user_text.strip()
        clean_speaker = speaker_name.strip() or "user"

        if not clean_text:
            return CommandResponse(reply="", speaker=clean_speaker, remembered=False)

        speaker_facts = self.memory.get_facts_about_speaker(clean_speaker, n_results=8)
        related_memories = self.memory.query_memories(
            clean_text,
            n_results=5,
            filter_by_speaker=clean_speaker,
        )
        general_memories = self.memory.query_memories(clean_text, n_results=3)
        reference_context = self._get_reference_context(clean_text)

        if self.client is None:
            fallback = self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            self.memory.add_memory(clean_text, speaker=clean_speaker, source="conversation")
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        if not self.settings.openrouter_chat_model:
            fallback = "OpenRouter is configured, but OPENROUTER_CHAT_MODEL is empty. Pick a model when ready."
            self.memory.add_memory(clean_text, speaker=clean_speaker, source="conversation")
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        system_message = self._build_system_message()
        context = self._build_context(
            speaker_name=clean_speaker,
            speaker_facts=speaker_facts,
            related_memories=related_memories,
            general_memories=general_memories,
            reference_context=reference_context,
        )

        response = await self.client.chat.completions.create(
            model=self.settings.openrouter_chat_model,
            messages=[
                {"role": "system", "content": system_message},
                {"role": "user", "content": f"Context:\n{context}\n\nUser ({clean_speaker}): {clean_text}"},
            ],
        )

        reply = response.choices[0].message.content or ""
        self.memory.add_memory(clean_text, speaker=clean_speaker, source="conversation")

        if reply:
            self.memory.add_memory(reply, speaker="fear", source="assistant_reply")

        return CommandResponse(reply=reply, speaker=clean_speaker, remembered=True)

    def _build_system_message(self) -> str:
        return (
            "You are F.E.A.R., a quiet, intelligent, empathetic desktop friend and assistant. "
            "You use personal memories only to be helpful and personal, never invasive. "
            "Give direct, useful advice. "
            "When giving relationship advice, be respectful, consent-focused, honest, and non-manipulative. "
            "If local reference notes are provided, use them as inspiration, not as absolute truth."
        )

    def _build_context(
        self,
        *,
        speaker_name: str,
        speaker_facts: list[PersonalMemoryResult],
        related_memories: list[PersonalMemoryResult],
        general_memories: list[PersonalMemoryResult],
        reference_context: str,
    ) -> str:
        sections = [f"Current speaker: {speaker_name}"]

        sections.append("\nRecent facts about this speaker:")
        sections.extend(format_memory_list(speaker_facts) or ["- none"])

        sections.append("\nRelevant memories about this speaker:")
        sections.extend(format_memory_list(related_memories) or ["- none"])

        sections.append("\nOther relevant memories:")
        sections.extend(format_memory_list(general_memories) or ["- none"])

        sections.append("\nLocal reference notes:")
        sections.append(reference_context or "- none")

        return "\n".join(sections)

    def _get_reference_context(self, topic: str) -> str:
        if self.reference_library is None:
            return ""

        results = self.reference_library.retrieve(topic, n_results=3)
        if not results:
            return ""

        lines: list[str] = []
        for result in results:
            lines.append(f"- [{result.source} / {result.section}] {result.text}")

        return "\n".join(lines)

    @staticmethod
    def _fallback_reply(
        user_text: str,
        speaker_name: str,
        speaker_facts: list[PersonalMemoryResult],
    ) -> str:
        facts = format_memory_list(speaker_facts[:3])
        if facts:
            return (
                f"I heard you, {speaker_name}. I saved that. "
                "OpenRouter is not configured yet, so I cannot generate a full answer."
            )

        return (
            f"I heard you, {speaker_name}. I saved that. "
            "Set OPENROUTER_API_KEY and OPENROUTER_CHAT_MODEL when you want full replies."
        )


def format_memory_list(memories: list[PersonalMemoryResult]) -> list[str]:
    """Format memories for prompt context."""
    lines: list[str] = []

    for memory in memories:
        lines.append(
            f"- speaker={memory.speaker}; source={memory.source}; text={memory.text}"
        )

    return lines

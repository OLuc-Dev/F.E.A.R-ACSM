from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING

from openai import AsyncOpenAI

from fear.config import Settings
from fear.library.reference_library import ReferenceLibrary
from fear.memory.personal_memory import PersonalMemory, PersonalMemoryResult

if TYPE_CHECKING:
    from fear.integrations.spotify_client import SpotifyClient


# Only route to Spotify when the message clearly refers to music. This keeps the
# assistant from hijacking ordinary conversation that happens to contain a verb
# like "play" or "stop".
SPOTIFY_HINTS = ("spotify", "music", "song", "track", "playback")


@dataclass(slots=True)
class CommandResponse:
    """Result of one conversational command."""

    reply: str
    speaker: str
    remembered: bool


class AsyncConversationalBrain:
    """
    Async-safe conversational layer for F.E.A.R.

    PersonalMemory and ReferenceLibrary use sentence-transformers and ChromaDB,
    which are blocking. This class keeps FastAPI responsive by moving those
    calls to worker threads with asyncio.to_thread.
    """

    def __init__(
        self,
        *,
        settings: Settings,
        memory: PersonalMemory,
        reference_library: ReferenceLibrary | None = None,
        spotify: SpotifyClient | None = None,
    ) -> None:
        self.settings = settings
        self.memory = memory
        self.reference_library = reference_library
        self.spotify = spotify
        self.client: AsyncOpenAI | None = None

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
        """Process one memory-aware command without blocking the event loop."""
        clean_text = user_text.strip()
        clean_speaker = speaker_name.strip() or "user"

        if not clean_text:
            return CommandResponse(reply="", speaker=clean_speaker, remembered=False)

        spotify_reply = await self._try_spotify(clean_text)
        if spotify_reply:
            await asyncio.to_thread(
                self.memory.add_memory,
                clean_text,
                clean_speaker,
                "spotify",
            )
            return CommandResponse(reply=spotify_reply, speaker=clean_speaker, remembered=True)

        speaker_facts_task = asyncio.to_thread(
            self.memory.get_facts_about_speaker,
            clean_speaker,
            8,
        )
        related_memories_task = asyncio.to_thread(
            self.memory.query_memories,
            clean_text,
            5,
            clean_speaker,
        )
        general_memories_task = asyncio.to_thread(
            self.memory.query_memories,
            clean_text,
            3,
            None,
        )
        reference_context_task = asyncio.to_thread(self._get_reference_context_sync, clean_text)

        speaker_facts, related_memories, general_memories, reference_context = await asyncio.gather(
            speaker_facts_task,
            related_memories_task,
            general_memories_task,
            reference_context_task,
        )

        if self.client is None:
            fallback = self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            await asyncio.to_thread(
                self.memory.add_memory,
                clean_text,
                clean_speaker,
                "conversation",
            )
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        if not self.settings.openrouter_chat_model:
            fallback = "OpenRouter is configured, but OPENROUTER_CHAT_MODEL is empty. Pick a model when ready."
            await asyncio.to_thread(
                self.memory.add_memory,
                clean_text,
                clean_speaker,
                "conversation",
            )
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

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
                {"role": "system", "content": self._build_system_message()},
                {"role": "user", "content": f"Context:\n{context}\n\nUser ({clean_speaker}): {clean_text}"},
            ],
        )

        reply = response.choices[0].message.content or ""
        await asyncio.to_thread(
            self.memory.add_memory,
            clean_text,
            clean_speaker,
            "conversation",
        )

        if reply:
            await asyncio.to_thread(
                self.memory.add_memory,
                reply,
                "fear",
                "assistant_reply",
            )

        return CommandResponse(reply=reply, speaker=clean_speaker, remembered=True)

    async def _try_spotify(self, text: str) -> str:
        """Route clear music commands to Spotify, returning "" when not applicable."""
        if self.spotify is None:
            return ""

        lowered = text.lower()
        if not any(hint in lowered for hint in SPOTIFY_HINTS):
            return ""

        return await self.spotify.handle_intent(lowered)

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

    def _get_reference_context_sync(self, topic: str) -> str:
        if self.reference_library is None:
            return ""

        results = self.reference_library.retrieve(topic, n_results=3)
        if not results:
            return ""

        return "\n".join(
            f"- [{result.source} / {result.section}] {result.text}"
            for result in results
        )

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
    return [
        f"- speaker={memory.speaker}; source={memory.source}; text={memory.text}"
        for memory in memories
    ]

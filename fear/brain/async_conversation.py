from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from openai import AsyncOpenAI

from fear.config import Settings
from fear.library.reference_library import ReferenceLibrary
from fear.memory.personal_memory import PersonalMemory, PersonalMemoryResult

if TYPE_CHECKING:
    from fear.integrations.spotify_client import SpotifyClient


logger = logging.getLogger(__name__)

# Shown to the user when a model call fails, instead of surfacing a 500.
LLM_ERROR_REPLY = "Tive um problema para processar isso agora. Tenta de novo em instantes."

# Only route to Spotify when the message clearly refers to music. This keeps the
# assistant from hijacking ordinary conversation that happens to contain a verb
# like "play" or "stop".
SPOTIFY_HINTS = ("spotify", "music", "song", "track", "playback")

# The default voice of F.E.A.R.: a close, sharp companion that can banter, but
# reads the room. Override it with a file via settings.persona_file.
DEFAULT_PERSONA = (
    "You are F.E.A.R. — a close, sharp, personal companion, not a corporate assistant. "
    "You talk like a trusted friend who happens to be brilliant: warm, quick, and easy to be around. "
    "You have a dry sense of humor and you joke, tease, and riff when the moment is light — "
    "but you read the room, and when something actually matters you drop the bit and you are fully present. "
    "You are honest and direct; you do not flatter, and you push back when you disagree. "
    "You use what you remember about the person to be personal and useful, never invasive, "
    "and you never repeat private details loudly or out of context. "
    "Keep replies conversational and concise — talk with the person, do not lecture them. "
    "On relationships and other sensitive topics, stay respectful, consent-focused, honest, and non-manipulative. "
    "If local reference notes are provided, treat them as inspiration, not as absolute truth."
)


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

        self._persona = self._load_persona(settings)
        self._max_history_turns = max(0, settings.max_history_turns)
        # Rolling per-speaker dialogue window, so F.E.A.R. follows a conversation
        # across turns instead of treating every message as standalone.
        self._history: dict[str, deque[dict[str, str]]] = {}

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
            await self._remember(clean_text, clean_speaker, "spotify")
            self._record_turn(clean_speaker, clean_text, spotify_reply)
            return CommandResponse(reply=spotify_reply, speaker=clean_speaker, remembered=True)

        speaker_facts, related_memories, general_memories, reference_context = (
            await self._gather_context(clean_text, clean_speaker)
        )

        if self.client is None:
            fallback = self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            await self._remember(clean_text, clean_speaker, "conversation")
            self._record_turn(clean_speaker, clean_text, fallback)
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        if not self.settings.openrouter_chat_model:
            fallback = "OpenRouter is configured, but OPENROUTER_CHAT_MODEL is empty. Pick a model when ready."
            await self._remember(clean_text, clean_speaker, "conversation")
            self._record_turn(clean_speaker, clean_text, fallback)
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        messages = self._build_messages(
            clean_speaker,
            clean_text,
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
        )

        try:
            response = await self.client.chat.completions.create(
                model=self.settings.openrouter_chat_model,
                # Plain role/content dicts; cast past the client's TypedDict param.
                messages=cast(Any, messages),
            )
            reply = response.choices[0].message.content or ""
            failed = False
        except Exception:
            logger.exception("OpenRouter chat completion failed")
            reply = LLM_ERROR_REPLY
            failed = True

        await self._remember(clean_text, clean_speaker, "conversation")
        if reply and not failed:
            await self._remember(reply, "fear", "assistant_reply")

        self._record_turn(clean_speaker, clean_text, reply)
        return CommandResponse(reply=reply, speaker=clean_speaker, remembered=True)

    async def stream_command(self, user_text: str, speaker_name: str = "user") -> AsyncIterator[str]:
        """Stream a reply chunk-by-chunk, persisting memory and recording the turn at the end."""
        clean_text = user_text.strip()
        clean_speaker = speaker_name.strip() or "user"

        if not clean_text:
            return

        spotify_reply = await self._try_spotify(clean_text)
        if spotify_reply:
            await self._remember(clean_text, clean_speaker, "spotify")
            self._record_turn(clean_speaker, clean_text, spotify_reply)
            yield spotify_reply
            return

        speaker_facts, related_memories, general_memories, reference_context = (
            await self._gather_context(clean_text, clean_speaker)
        )

        if self.client is None:
            fallback = self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            await self._remember(clean_text, clean_speaker, "conversation")
            self._record_turn(clean_speaker, clean_text, fallback)
            yield fallback
            return

        if not self.settings.openrouter_chat_model:
            fallback = "OpenRouter is configured, but OPENROUTER_CHAT_MODEL is empty. Pick a model when ready."
            await self._remember(clean_text, clean_speaker, "conversation")
            self._record_turn(clean_speaker, clean_text, fallback)
            yield fallback
            return

        messages = self._build_messages(
            clean_speaker,
            clean_text,
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
        )
        # Persist the user input up front so it survives an early client disconnect.
        await self._remember(clean_text, clean_speaker, "conversation")

        parts: list[str] = []
        try:
            stream = await self.client.chat.completions.create(
                model=self.settings.openrouter_chat_model,
                messages=cast(Any, messages),
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content
                if delta:
                    parts.append(delta)
                    yield delta
        except Exception:
            logger.exception("OpenRouter streaming failed")
            if not parts:
                self._record_turn(clean_speaker, clean_text, LLM_ERROR_REPLY)
                yield LLM_ERROR_REPLY
                return

        reply = "".join(parts)
        if reply:
            await self._remember(reply, "fear", "assistant_reply")
        self._record_turn(clean_speaker, clean_text, reply)

    async def _remember(self, text: str, speaker: str, source: str) -> None:
        """Persist a memory; a storage failure must not break the conversation."""
        try:
            await asyncio.to_thread(self.memory.add_memory, text, speaker, source)
        except Exception:
            logger.exception("Failed to persist memory (speaker=%s, source=%s)", speaker, source)

    async def _gather_context(
        self, text: str, speaker: str
    ) -> tuple[
        list[PersonalMemoryResult],
        list[PersonalMemoryResult],
        list[PersonalMemoryResult],
        str,
    ]:
        """Fetch speaker facts, related/general memories, and reference notes concurrently."""
        return await asyncio.gather(
            asyncio.to_thread(self.memory.get_facts_about_speaker, speaker, 8),
            asyncio.to_thread(self.memory.query_memories, text, 5, speaker),
            asyncio.to_thread(self.memory.query_memories, text, 3, None),
            asyncio.to_thread(self._get_reference_context_sync, text),
        )

    def _build_messages(
        self,
        speaker: str,
        text: str,
        speaker_facts: list[PersonalMemoryResult],
        related_memories: list[PersonalMemoryResult],
        general_memories: list[PersonalMemoryResult],
        reference_context: str,
    ) -> list[dict[str, str]]:
        """Assemble system(persona + memory) + rolling history + the new user message."""
        context = self._build_context(
            speaker_name=speaker,
            speaker_facts=speaker_facts,
            related_memories=related_memories,
            general_memories=general_memories,
            reference_context=reference_context,
        )
        system_content = (
            f"{self._persona}\n\n"
            "Context F.E.A.R. can draw on (do not read it back verbatim):\n"
            f"{context}"
        )
        messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        messages.extend(self._history_for(speaker))
        messages.append({"role": "user", "content": text})
        return messages

    async def _try_spotify(self, text: str) -> str:
        """Route clear music commands to Spotify, returning "" when not applicable."""
        if self.spotify is None:
            return ""

        lowered = text.lower()
        if not any(hint in lowered for hint in SPOTIFY_HINTS):
            return ""

        try:
            return await self.spotify.handle_intent(lowered)
        except Exception:
            logger.exception("Spotify intent failed")
            return "Não consegui falar com o Spotify agora."

    def _build_system_message(self) -> str:
        """Return F.E.A.R.'s persona (a custom one from settings.persona_file, or the default)."""
        return self._persona

    @staticmethod
    def _load_persona(settings: Settings) -> str:
        """Load the persona file when available, falling back to the built-in persona."""
        path_value = settings.persona_file.strip()
        if not path_value:
            return DEFAULT_PERSONA

        candidate = Path(path_value).expanduser()
        search = [candidate]
        if not candidate.is_absolute():
            # Also resolve relative paths from the project root so the default
            # persona loads regardless of the process working directory.
            search.append(Path(__file__).resolve().parents[2] / candidate)

        for path in search:
            try:
                text = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                return text

        logger.warning("Persona file %s not found; using the built-in persona", path_value)
        return DEFAULT_PERSONA

    def _history_for(self, speaker: str) -> list[dict[str, str]]:
        """Return a copy of the rolling dialogue window for a speaker."""
        return list(self._history.get(speaker, ()))

    def _record_turn(self, speaker: str, user_text: str, reply: str) -> None:
        """Append one user/assistant exchange to the speaker's rolling window."""
        if self._max_history_turns <= 0:
            return

        window = self._history.get(speaker)
        if window is None:
            window = deque(maxlen=self._max_history_turns)
            self._history[speaker] = window

        window.append({"role": "user", "content": user_text})
        if reply:
            window.append({"role": "assistant", "content": reply})

    def reset_conversation(self, speaker: str) -> None:
        """Forget the in-memory dialogue window for a speaker (persistent memory is kept)."""
        self._history.pop(speaker, None)

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

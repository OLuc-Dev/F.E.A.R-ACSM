from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, deque
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from openai import AsyncOpenAI

from fear.config import Settings
from fear.library.reference_library import ReferenceLibrary
from fear.memory.personal_memory import PersonalMemory, PersonalMemoryResult

if TYPE_CHECKING:
    from fear.integrations.google_calendar import GoogleCalendarClient
    from fear.integrations.spotify_client import SpotifyClient


logger = logging.getLogger(__name__)

# Shown to the user when a model call fails, instead of surfacing a 500.
LLM_ERROR_REPLY = "Tive um problema para processar isso agora. Tenta de novo em instantes."

# Only route to Spotify when the message clearly refers to music. This keeps the
# assistant from hijacking ordinary conversation that happens to contain a verb
# like "play" or "stop".
SPOTIFY_HINTS = ("spotify", "music", "song", "track", "playback")

# Route to the calendar only on a clear agenda question (read-only), so ordinary
# chat that happens to mention a meeting isn't hijacked.
CALENDAR_HINTS = (
    "agenda",
    "calendário",
    "calendario",
    "compromisso",
    "meus eventos",
    "calendar",
    "schedule",
)

# Persona modes layered on top of the base persona. They only adjust tone; the
# persona file's loyalty and safety rails always take precedence.
PERSONA_MODES: dict[str, str] = {
    "equilibrio": "",
    "sombrio": (
        "Modo SOMBRIO ativo: aprofunde a frieza, a ironia e a lente niilista. "
        "Seja mais cortante e filosófico, menos reconfortante. As travas de lealdade "
        "e segurança da persona continuam valendo integralmente — a escuridão é da "
        "voz, nunca da intenção."
    ),
    "cirurgico": (
        "Modo CIRÚRGICO ativo: corte o teatro. Vá direto ao essencial — diagnóstico, "
        "decisão e próximo passo. Pouca filosofia, máxima densidade e ação."
    ),
}
DEFAULT_PERSONA_MODE = "equilibrio"

# Cap the per-user in-memory caches so a long-running process doesn't grow
# without bound. LRU: the least-recently-used entry is evicted first. These hold
# only volatile state (rolling dialogue windows, per-key API clients) — evicting
# never touches persistent memory in ChromaDB.
_MAX_HISTORY_USERS = 500
_MAX_CLIENTS = 500

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


@dataclass(slots=True)
class UserContext:
    """Per-request identity for multi-user mode.

    When present, the conversation uses this user's own OpenRouter key + model
    and reads/writes only this user's memory. When absent, the brain runs in its
    original single-user mode (shared key, shared model, shared memory).
    """

    user_id: str
    api_key: str = ""
    chat_model: str = ""
    persona_mode: str = ""


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
        calendar: GoogleCalendarClient | None = None,
    ) -> None:
        self.settings = settings
        self.memory = memory
        self.reference_library = reference_library
        self.spotify = spotify
        self.calendar = calendar
        self.client: AsyncOpenAI | None = None
        # Per-user OpenRouter clients (BYO key), cached by the key itself so a
        # changed key transparently yields a fresh client. LRU-bounded.
        self._clients_by_key: OrderedDict[str, AsyncOpenAI] = OrderedDict()

        self._persona = self._load_persona(settings)
        # Live persona mode, seeded from settings (FEAR_PERSONA_MODE); an unknown
        # value falls back to the balanced default rather than failing startup.
        self._persona_mode = (
            settings.persona_mode
            if settings.persona_mode in PERSONA_MODES
            else DEFAULT_PERSONA_MODE
        )
        self._max_history_turns = max(0, settings.max_history_turns)
        # Rolling per-speaker dialogue window, so F.E.A.R. follows a conversation
        # across turns instead of treating every message as standalone. LRU-bounded.
        self._history: OrderedDict[str, deque[dict[str, str]]] = OrderedDict()

        if settings.openrouter_api_key:
            self.client = AsyncOpenAI(
                api_key=settings.openrouter_api_key,
                base_url=settings.openrouter_base_url,
                default_headers={
                    "HTTP-Referer": settings.openrouter_http_referer,
                    "X-Title": settings.openrouter_app_title,
                },
            )

    @staticmethod
    def _evict_lru(cache: OrderedDict[str, Any], cap: int) -> None:
        """Drop least-recently-used entries until the cache is within `cap`."""
        while len(cache) > cap:
            cache.popitem(last=False)

    def _client_for(self, user: UserContext | None) -> AsyncOpenAI | None:
        """Pick the OpenRouter client: the user's own (BYO key) or the shared one."""
        if user is None or not user.api_key:
            return self.client
        cached = self._clients_by_key.get(user.api_key)
        if cached is not None:
            self._clients_by_key.move_to_end(user.api_key)  # mark most-recently-used
            return cached
        cached = AsyncOpenAI(
            api_key=user.api_key,
            base_url=self.settings.openrouter_base_url,
            default_headers={
                "HTTP-Referer": self.settings.openrouter_http_referer,
                "X-Title": self.settings.openrouter_app_title,
            },
        )
        self._clients_by_key[user.api_key] = cached
        self._evict_lru(self._clients_by_key, _MAX_CLIENTS)
        return cached

    async def process_command(
        self, user_text: str, speaker_name: str = "user", user: UserContext | None = None
    ) -> CommandResponse:
        """Process one memory-aware command without blocking the event loop."""
        clean_text = user_text.strip()
        clean_speaker = speaker_name.strip() or "user"

        if not clean_text:
            return CommandResponse(reply="", speaker=clean_speaker, remembered=False)

        client = self._client_for(user)
        model = user.chat_model if user and user.chat_model else self.settings.openrouter_chat_model
        persona_mode = user.persona_mode if user and user.persona_mode else self._persona_mode
        # Memory scope + history key: isolated per user when logged in, shared
        # (by speaker) otherwise.
        scope = user.user_id if user else ""
        history_key = user.user_id if user else clean_speaker

        spotify_reply = await self._try_spotify(clean_text)
        if spotify_reply:
            await self._remember(clean_text, clean_speaker, "spotify", scope)
            self._record_turn(history_key, clean_text, spotify_reply)
            return CommandResponse(reply=spotify_reply, speaker=clean_speaker, remembered=True)

        calendar_summary = await self._try_calendar(clean_text)
        # Without a model, hand back the raw agenda; with one, F.E.A.R. phrases it below.
        if calendar_summary and client is None:
            await self._remember(clean_text, clean_speaker, "calendar", scope)
            self._record_turn(history_key, clean_text, calendar_summary)
            return CommandResponse(reply=calendar_summary, speaker=clean_speaker, remembered=True)

        (
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
        ) = await self._gather_context(clean_text, clean_speaker, scope)

        if client is None:
            fallback = (
                self._needs_key_reply(clean_speaker)
                if user is not None
                else self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            )
            await self._remember(clean_text, clean_speaker, "conversation", scope)
            self._record_turn(history_key, clean_text, fallback)
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        if not model:
            fallback = (
                "OpenRouter is configured, but no chat model is set. Pick a model when ready."
            )
            await self._remember(clean_text, clean_speaker, "conversation", scope)
            self._record_turn(history_key, clean_text, fallback)
            return CommandResponse(reply=fallback, speaker=clean_speaker, remembered=True)

        messages = self._build_messages(
            clean_speaker,
            clean_text,
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
            calendar_summary,
            history_key=history_key,
            persona_mode=persona_mode,
        )

        try:
            response = await client.chat.completions.create(
                model=model,
                # Plain role/content dicts; cast past the client's TypedDict param.
                messages=cast(Any, messages),
            )
            reply = response.choices[0].message.content or ""
            failed = False
        except Exception:
            logger.exception("OpenRouter chat completion failed")
            reply = LLM_ERROR_REPLY
            failed = True

        await self._remember(clean_text, clean_speaker, "conversation", scope)
        if reply and not failed:
            await self._remember(reply, "fear", "assistant_reply", scope)

        self._record_turn(history_key, clean_text, reply)
        return CommandResponse(reply=reply, speaker=clean_speaker, remembered=True)

    async def stream_command(
        self, user_text: str, speaker_name: str = "user", user: UserContext | None = None
    ) -> AsyncIterator[str]:
        """Stream a reply chunk-by-chunk, persisting memory and recording the turn at the end."""
        clean_text = user_text.strip()
        clean_speaker = speaker_name.strip() or "user"

        if not clean_text:
            return

        client = self._client_for(user)
        model = user.chat_model if user and user.chat_model else self.settings.openrouter_chat_model
        persona_mode = user.persona_mode if user and user.persona_mode else self._persona_mode
        scope = user.user_id if user else ""
        history_key = user.user_id if user else clean_speaker

        spotify_reply = await self._try_spotify(clean_text)
        if spotify_reply:
            await self._remember(clean_text, clean_speaker, "spotify", scope)
            self._record_turn(history_key, clean_text, spotify_reply)
            yield spotify_reply
            return

        calendar_summary = await self._try_calendar(clean_text)
        if calendar_summary and client is None:
            await self._remember(clean_text, clean_speaker, "calendar", scope)
            self._record_turn(history_key, clean_text, calendar_summary)
            yield calendar_summary
            return

        (
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
        ) = await self._gather_context(clean_text, clean_speaker, scope)

        if client is None:
            fallback = (
                self._needs_key_reply(clean_speaker)
                if user is not None
                else self._fallback_reply(clean_text, clean_speaker, speaker_facts)
            )
            await self._remember(clean_text, clean_speaker, "conversation", scope)
            self._record_turn(history_key, clean_text, fallback)
            yield fallback
            return

        if not model:
            fallback = (
                "OpenRouter is configured, but no chat model is set. Pick a model when ready."
            )
            await self._remember(clean_text, clean_speaker, "conversation", scope)
            self._record_turn(history_key, clean_text, fallback)
            yield fallback
            return

        messages = self._build_messages(
            clean_speaker,
            clean_text,
            speaker_facts,
            related_memories,
            general_memories,
            reference_context,
            calendar_summary,
            history_key=history_key,
            persona_mode=persona_mode,
        )
        # Persist the user input up front so it survives an early client disconnect.
        await self._remember(clean_text, clean_speaker, "conversation", scope)

        parts: list[str] = []
        try:
            stream = await client.chat.completions.create(
                model=model,
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
                self._record_turn(history_key, clean_text, LLM_ERROR_REPLY)
                yield LLM_ERROR_REPLY
                return

        reply = "".join(parts)
        if reply:
            await self._remember(reply, "fear", "assistant_reply", scope)
        self._record_turn(history_key, clean_text, reply)

    async def _remember(self, text: str, speaker: str, source: str, user_id: str = "") -> None:
        """Persist a memory; a storage failure must not break the conversation."""
        try:
            await asyncio.to_thread(self.memory.add_memory, text, speaker, source, user_id)
        except Exception:
            logger.exception("Failed to persist memory (speaker=%s, source=%s)", speaker, source)

    async def _gather_context(
        self, text: str, speaker: str, user_id: str = ""
    ) -> tuple[
        list[PersonalMemoryResult],
        list[PersonalMemoryResult],
        list[PersonalMemoryResult],
        str,
    ]:
        """Fetch speaker facts, related/general memories, and reference notes concurrently.

        All memory reads are scoped to ``user_id`` when set, so a logged-in user's
        "other relevant memories" bucket still stays within their own memory.
        """
        speaker_facts, related_memories, general_memories, reference_context = await asyncio.gather(
            asyncio.to_thread(self.memory.get_facts_about_speaker, speaker, 8, user_id),
            asyncio.to_thread(self.memory.query_memories, text, 5, speaker, user_id),
            asyncio.to_thread(self.memory.query_memories, text, 6, None, user_id),
            asyncio.to_thread(self._get_reference_context_sync, text, user_id),
        )
        # Keep F.E.A.R.'s own past replies out of the cross-speaker bucket so its
        # context is grounded in what people said, not an echo of what it answered.
        general_memories = [memory for memory in general_memories if memory.speaker != "fear"][:3]
        return speaker_facts, related_memories, general_memories, reference_context

    def _build_messages(
        self,
        speaker: str,
        text: str,
        speaker_facts: list[PersonalMemoryResult],
        related_memories: list[PersonalMemoryResult],
        general_memories: list[PersonalMemoryResult],
        reference_context: str,
        calendar_summary: str = "",
        history_key: str | None = None,
        persona_mode: str | None = None,
    ) -> list[dict[str, str]]:
        """Assemble system(persona + memory) + rolling history + the new user message."""
        context = self._build_context(
            speaker_name=speaker,
            speaker_facts=speaker_facts,
            related_memories=related_memories,
            general_memories=general_memories,
            reference_context=reference_context,
            calendar_summary=calendar_summary,
        )
        mode = persona_mode if persona_mode is not None else self._persona_mode
        directive = PERSONA_MODES.get(mode, "")
        persona_block = self._persona if not directive else f"{self._persona}\n\n{directive}"
        system_content = (
            f"{persona_block}\n\n"
            "Context F.E.A.R. can draw on (do not read it back verbatim):\n"
            f"{context}"
        )
        messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        messages.extend(self._history_for(history_key if history_key is not None else speaker))
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

    async def _try_calendar(self, text: str) -> str:
        """Route clear agenda questions to the calendar (read-only); "" otherwise."""
        if self.calendar is None:
            return ""

        lowered = text.lower()
        if not any(hint in lowered for hint in CALENDAR_HINTS):
            return ""

        try:
            return await self.calendar.handle_intent(lowered)
        except Exception:
            logger.exception("Calendar intent failed")
            return "Não consegui acessar sua agenda agora."

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
        window = self._history.get(speaker)
        if window is None:
            return []
        self._history.move_to_end(speaker)  # accessing marks it most-recently-used
        return list(window)

    def _record_turn(self, speaker: str, user_text: str, reply: str) -> None:
        """Append one user/assistant exchange to the speaker's rolling window."""
        if self._max_history_turns <= 0:
            return

        window = self._history.get(speaker)
        if window is None:
            window = deque(maxlen=self._max_history_turns)
            self._history[speaker] = window
            self._evict_lru(self._history, _MAX_HISTORY_USERS)
        else:
            self._history.move_to_end(speaker)  # active speaker stays most-recent

        window.append({"role": "user", "content": user_text})
        if reply:
            window.append({"role": "assistant", "content": reply})

    def reset_conversation(self, speaker: str) -> None:
        """Forget the in-memory dialogue window for a speaker (persistent memory is kept)."""
        self._history.pop(speaker, None)

    def set_chat_model(self, model: str) -> None:
        """Switch the OpenRouter chat model for this session (ignores blank input)."""
        cleaned = model.strip()
        if cleaned:
            self.settings.openrouter_chat_model = cleaned

    def set_persona_mode(self, mode: str) -> None:
        """Switch the persona mode; raises ValueError for an unknown mode."""
        cleaned = mode.strip().lower()
        if cleaned not in PERSONA_MODES:
            raise ValueError(f"unknown persona mode: {mode}")
        self._persona_mode = cleaned

    def get_config(self) -> dict[str, Any]:
        """Return the live, non-secret runtime config (drives the settings panel)."""
        return {
            "model": self.settings.openrouter_chat_model,
            "persona_mode": self._persona_mode,
            "persona_modes": list(PERSONA_MODES.keys()),
        }

    def _build_context(
        self,
        *,
        speaker_name: str,
        speaker_facts: list[PersonalMemoryResult],
        related_memories: list[PersonalMemoryResult],
        general_memories: list[PersonalMemoryResult],
        reference_context: str,
        calendar_summary: str = "",
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

        if calendar_summary:
            sections.append(
                "\nLive calendar (answer from this in your own voice; never invent events):"
            )
            sections.append(calendar_summary)

        return "\n".join(sections)

    def _get_reference_context_sync(self, topic: str, user_id: str = "") -> str:
        if self.reference_library is None:
            return ""

        results = self.reference_library.retrieve(topic, n_results=3, user_id=user_id)
        if not results:
            return ""

        return "\n".join(
            f"- [{result.source} / {result.section}] {result.text}" for result in results
        )

    @staticmethod
    def _needs_key_reply(speaker_name: str) -> str:
        """Shown to a signed-in user who hasn't added their own OpenRouter key yet."""
        return (
            f"Estou aqui, {speaker_name} — mas sem uma chave eu não penso. "
            "Abra sua conta no ícone de pessoa, lá em cima, e cole sua chave do "
            "OpenRouter. Faça isso e eu acordo."
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

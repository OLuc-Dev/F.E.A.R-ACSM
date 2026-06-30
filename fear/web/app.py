from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from fear.brain.async_conversation import AsyncConversationalBrain
from fear.config import DEFAULT_CHAT_MODEL, Settings
from fear.input.wearable_taps import GestureName, WearableTapEvent, gesture_to_command
from fear.library.reference_library import ReferenceLibrary
from fear.logging_config import configure_logging
from fear.memory.personal_memory import PersonalMemory
from fear.runtime_state import load_runtime_config, save_runtime_config

if TYPE_CHECKING:
    from fear.audio.voice_listener import TranscriptEvent

logger = logging.getLogger(__name__)


class CommandRequest(BaseModel):
    """Request body for /command."""

    text: str
    speaker: str = "user"
    speak: bool = True


class CommandResponse(BaseModel):
    """Response body for /command."""

    reply: str
    speaker: str
    audio_file: str | None = None


class MemoryResponse(BaseModel):
    """Response body for /memory/{speaker}."""

    speaker: str
    memories: list[dict[str, object]]


class ForgetRequest(BaseModel):
    """Request body for /memory/forget."""

    memory_id: str


class TapGesturePayload(BaseModel):
    """Request body for /wearable/tap."""

    gesture: GestureName = "single_tap"
    device_id: str | None = None
    speaker: str = "user"


class StatusResponse(BaseModel):
    """Which F.E.A.R. integrations are configured/active."""

    assistant: str
    openrouter: bool
    memory: bool
    voice: bool
    spotify: bool
    obsidian: bool
    calendar: bool


class KnowledgeTextRequest(BaseModel):
    """Request body for adding a free-text knowledge source."""

    name: str
    content: str


class KnowledgePathRequest(BaseModel):
    """Request body for indexing a local folder or markdown file as knowledge."""

    path: str
    source: str | None = None


class KnowledgeSource(BaseModel):
    """One indexed knowledge source and how many chunks it holds."""

    source: str
    chunks: int


class KnowledgeListResponse(BaseModel):
    """The configured knowledge sources (drives the settings panel)."""

    available: bool
    sources: list[KnowledgeSource]


class ConfigResponse(BaseModel):
    """Live, non-secret runtime configuration (drives the behaviour panel)."""

    model: str
    model_default: str
    persona_mode: str
    persona_modes: list[str]


class ConfigUpdate(BaseModel):
    """Partial update for runtime configuration. Secrets are never accepted here."""

    model: str | None = None
    persona_mode: str | None = None


def cors_origins() -> list[str]:
    """Read allowed CORS origins from FEAR_CORS_ORIGINS."""
    raw = os.getenv(
        "FEAR_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def env_bool(name: str, *, default: bool = False) -> bool:
    """Parse a boolean environment variable."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Dependency providers (read app state; overridable in tests) ---
def get_brain(request: Request) -> AsyncConversationalBrain:
    return request.app.state.brain


def get_memory(request: Request) -> PersonalMemory:
    return request.app.state.memory


def get_tts(request: Request) -> Any:
    return request.app.state.tts


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_reference_library(request: Request) -> ReferenceLibrary | None:
    """Return the reference library, or None when it could not be initialized."""
    return getattr(request.app.state, "reference_library", None)


def require_reference_library(library: ReferenceLibrary | None) -> ReferenceLibrary:
    """Guard endpoints that need the knowledge store, returning a clean 503 if absent."""
    if library is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Biblioteca de conhecimento indisponível. "
                "Instale as dependências (chromadb, sentence-transformers) e reinicie o backend."
            ),
        )
    return library


def require_local_client(request: Request) -> None:
    """Block filesystem-reading actions from non-local callers (e.g. a phone on the
    LAN), so arbitrary server paths can only be indexed from the host machine."""
    host = request.client.host if request.client else ""
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(
            status_code=403,
            detail="Indexar um caminho local só é permitido a partir da própria máquina.",
        )


async def process_text_command(application: FastAPI, text: str, speaker: str):
    """Process a text command through the configured brain (used by /ws and callbacks)."""
    return await application.state.brain.process_command(text, speaker)


async def process_voice_event(application: FastAPI, event: TranscriptEvent) -> None:
    """Process a transcript produced by the optional background voice listener."""
    result = await process_text_command(application, event.message, event.speaker)
    if result.reply:
        await application.state.tts.say(result.reply)


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Initialize and stop the unified F.E.A.R. runtime."""
    configure_logging()
    settings = Settings.from_env()
    logger.info("Starting F.E.A.R. runtime")

    # Hardware/IO-heavy modules are imported here so importing this module (and
    # testing the HTTP layer) does not require the audio/ML stack to be present.
    from fear.audio.natural_tts import NaturalTTS
    from fear.integrations.google_calendar import GoogleCalendarClient
    from fear.integrations.spotify_client import SpotifyClient
    from fear.memory.obsidian_watcher import ObsidianWatcher

    memory = await asyncio.to_thread(
        PersonalMemory,
        path=settings.chroma_path,
        collection_name="personal_memory",
    )
    reference_library = await asyncio.to_thread(
        ReferenceLibrary,
        path=settings.chroma_path,
        collection_name=os.getenv("BOOK_KNOWLEDGE_COLLECTION", "book_knowledge"),
    )

    # Loads only when SPOTIPY_* credentials are present; otherwise stays inert.
    spotify = SpotifyClient(scope=settings.spotify_scope)
    await spotify.load()

    # Loads only after a one-time google_login.py has cached a token; else inert.
    calendar = GoogleCalendarClient(
        credentials_file=settings.google_credentials_file,
        token_file=settings.google_token_file,
        calendar_id=settings.google_calendar_id,
        scope=settings.google_calendar_scope,
    )
    await calendar.load()

    application.state.settings = settings
    application.state.memory = memory
    application.state.reference_library = reference_library
    application.state.spotify = spotify
    application.state.calendar = calendar
    application.state.tts = NaturalTTS()
    application.state.brain = AsyncConversationalBrain(
        settings=settings,
        memory=memory,
        reference_library=reference_library,
        spotify=spotify,
        calendar=calendar,
    )

    # Re-apply the panel's last model/mode choice on top of the .env defaults.
    overrides = load_runtime_config(settings.chroma_path)
    model_override = overrides.get("model")
    if isinstance(model_override, str):
        application.state.brain.set_chat_model(model_override)
    mode_override = overrides.get("persona_mode")
    if isinstance(mode_override, str):
        try:
            application.state.brain.set_persona_mode(mode_override)
        except ValueError:
            logger.warning("Ignoring unknown persisted persona mode: %s", mode_override)

    application.state.loop = asyncio.get_running_loop()
    application.state.voice_listener = None
    application.state.obsidian_watcher = None
    application.state.clap_detector = None

    obsidian_path = os.getenv("OBSIDIAN_VAULT_PATH", "").strip()
    if obsidian_path:
        watcher = ObsidianWatcher(
            vault_path=obsidian_path,
            memory=memory,
            speaker=os.getenv("OBSIDIAN_SPEAKER", "fear_user"),
        )
        watcher.start()
        application.state.obsidian_watcher = watcher

    if env_bool("FEAR_ENABLE_VOICE_LISTENER", default=False):
        # Imported here so the heavy audio stack (whisper, pyaudio) is only
        # needed when voice input is explicitly enabled — install it with
        # `pip install -e ".[audio]"`.
        from fear.audio.voice_listener import VoiceListener

        def on_transcript(event: TranscriptEvent) -> None:
            loop = application.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(process_voice_event(application, event))
            )

        listener = VoiceListener(
            on_transcript=on_transcript,
            model_name=settings.whisper_model_name,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        listener.start()
        application.state.voice_listener = listener

    if env_bool("FEAR_ENABLE_CLAP_DETECTOR", default=False):
        from fear.input.clap_detector import ClapDetector

        def on_double_clap() -> None:
            loop = application.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(
                    process_text_command(application, "toggle Spotify playback", "clap")
                )
            )

        clap_detector = ClapDetector(
            on_double_clap=on_double_clap,
            threshold=settings.clap_threshold,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        clap_detector.start()
        application.state.clap_detector = clap_detector

    try:
        yield
    finally:
        active_listener = getattr(application.state, "voice_listener", None)
        if active_listener is not None:
            active_listener.stop()

        active_watcher = getattr(application.state, "obsidian_watcher", None)
        if active_watcher is not None:
            active_watcher.stop()

        active_clap_detector = getattr(application.state, "clap_detector", None)
        if active_clap_detector is not None:
            active_clap_detector.stop()


app = FastAPI(title="F.E.A.R. Unified API", lifespan=lifespan)
allowed_origins = cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    # The CORS spec forbids wildcard origins with credentials; F.E.A.R. doesn't
    # use cookies, so when FEAR_CORS_ORIGINS="*" (handy for testing from a phone
    # on the same Wi-Fi) we drop credentials to keep browsers happy.
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log unhandled errors and return a clean payload instead of a stack trace."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500, content={"detail": "Internal error. The incident was logged."}
    )


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check."""
    settings = getattr(app.state, "settings", None)
    assistant_name = settings.assistant_name if settings else "F.E.A.R."
    return {"status": "ok", "assistant": assistant_name}


@app.get("/status", response_model=StatusResponse)
async def status(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> StatusResponse:
    """Report which integrations are configured/active (drives the system panel)."""
    spotify = getattr(request.app.state, "spotify", None)
    calendar = getattr(request.app.state, "calendar", None)
    return StatusResponse(
        assistant=settings.assistant_name,
        openrouter=bool(settings.openrouter_api_key and settings.openrouter_chat_model),
        memory=getattr(request.app.state, "memory", None) is not None,
        voice=getattr(request.app.state, "voice_listener", None) is not None,
        spotify=bool(spotify is not None and spotify.is_configured),
        obsidian=getattr(request.app.state, "obsidian_watcher", None) is not None,
        calendar=bool(calendar is not None and calendar.is_configured),
    )


@app.post("/command", response_model=CommandResponse)
async def command(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
    tts: Any = Depends(get_tts),
) -> CommandResponse:
    """Process a text command and optionally speak it locally."""
    result = await brain.process_command(payload.text, payload.speaker)

    if payload.speak and result.reply:
        audio_path = await tts.say(result.reply)
        if audio_path is not None:
            try:
                audio_path.unlink(missing_ok=True)
            except OSError:
                pass

    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.post("/command/stream")
async def command_stream(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
) -> StreamingResponse:
    """Stream the reply as plain-text chunks as the model produces them."""

    async def generate() -> AsyncIterator[str]:
        async for chunk in brain.stream_command(payload.text, payload.speaker):
            yield chunk

    # Disable proxy/browser buffering so tokens reach the client as they are produced.
    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/memory/{speaker}", response_model=MemoryResponse)
async def memory_for_speaker(
    speaker: str,
    memory: PersonalMemory = Depends(get_memory),
) -> MemoryResponse:
    """Return recent memories for a speaker."""
    facts = await asyncio.to_thread(memory.get_facts_about_speaker, speaker)
    return MemoryResponse(
        speaker=speaker,
        memories=[
            {"id": item.id, "text": item.text, "source": item.source, "timestamp": item.timestamp}
            for item in facts
        ],
    )


@app.post("/memory/forget")
async def memory_forget(
    payload: ForgetRequest,
    memory: PersonalMemory = Depends(get_memory),
) -> dict[str, object]:
    """Delete a single memory by id."""
    forgotten = await asyncio.to_thread(memory.forget, payload.memory_id)
    return {"forgotten": forgotten, "id": payload.memory_id}


@app.get("/knowledge", response_model=KnowledgeListResponse)
async def knowledge_list(
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> KnowledgeListResponse:
    """List the knowledge sources F.E.A.R. can draw on."""
    if library is None:
        return KnowledgeListResponse(available=False, sources=[])

    sources = await asyncio.to_thread(library.list_sources)
    return KnowledgeListResponse(
        available=True,
        sources=[KnowledgeSource(source=item["source"], chunks=item["chunks"]) for item in sources],
    )


@app.post("/knowledge/text", response_model=KnowledgeSource)
async def knowledge_add_text(
    payload: KnowledgeTextRequest,
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> KnowledgeSource:
    """Add a free-text knowledge source (a named, editable note)."""
    store = require_reference_library(library)
    name = payload.name.strip() or "nota"
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="O conteúdo não pode ser vazio.")

    chunks = await asyncio.to_thread(store.index_text, content, source=name)
    return KnowledgeSource(source=name, chunks=chunks)


@app.post("/knowledge/path", response_model=KnowledgeSource)
async def knowledge_add_path(
    request: Request,
    payload: KnowledgePathRequest,
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> KnowledgeSource:
    """Index a local folder of markdown notes, or a single markdown file."""
    require_local_client(request)
    store = require_reference_library(library)
    path = Path(payload.path.strip()).expanduser()
    source = (payload.source or "").strip() or (path.stem or "fonte")

    if path.is_dir():
        chunks = await asyncio.to_thread(store.index_folder, path, source=source)
    elif path.is_file():
        chunks = await asyncio.to_thread(store.index_file, path, source=source)
    else:
        raise HTTPException(status_code=404, detail=f"Caminho não encontrado: {path}")

    return KnowledgeSource(source=source, chunks=chunks)


@app.delete("/knowledge/{source}")
async def knowledge_delete(
    source: str,
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> dict[str, object]:
    """Remove a knowledge source and all of its chunks."""
    store = require_reference_library(library)
    deleted = await asyncio.to_thread(store.delete_source, source)
    return {"source": source, "deleted": deleted}


@app.post("/wearable/tap", response_model=CommandResponse)
async def wearable_tap(
    payload: TapGesturePayload,
    brain: AsyncConversationalBrain = Depends(get_brain),
) -> CommandResponse:
    """Process a simple wearable tap as a command."""
    text = gesture_to_command(WearableTapEvent(payload.gesture, payload.device_id))
    result = await brain.process_command(text or payload.gesture, payload.speaker)
    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.post("/conversation/reset")
async def conversation_reset(
    speaker: str = "user",
    brain: AsyncConversationalBrain = Depends(get_brain),
) -> dict[str, str]:
    """Clear the in-memory dialogue window for a speaker (persistent memory is kept)."""
    brain.reset_conversation(speaker)
    return {"status": "reset", "speaker": speaker}


def _config_response(brain: AsyncConversationalBrain) -> ConfigResponse:
    config = brain.get_config()
    return ConfigResponse(
        model=config["model"],
        model_default=DEFAULT_CHAT_MODEL,
        persona_mode=config["persona_mode"],
        persona_modes=config["persona_modes"],
    )


@app.get("/config", response_model=ConfigResponse)
async def config_get(
    brain: AsyncConversationalBrain = Depends(get_brain),
) -> ConfigResponse:
    """Return the live, non-secret runtime configuration."""
    return _config_response(brain)


@app.post("/config", response_model=ConfigResponse)
async def config_set(
    payload: ConfigUpdate,
    brain: AsyncConversationalBrain = Depends(get_brain),
    settings: Settings = Depends(get_settings),
) -> ConfigResponse:
    """Update the chat model and/or persona mode (no secrets); persisted across restarts."""
    if payload.model is not None:
        brain.set_chat_model(payload.model)
    if payload.persona_mode is not None:
        try:
            brain.set_persona_mode(payload.persona_mode)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="Modo de persona inválido.") from exc

    config = brain.get_config()
    save_runtime_config(
        settings.chroma_path,
        model=str(config["model"]),
        persona_mode=str(config["persona_mode"]),
    )
    return _config_response(brain)


@app.post("/voice/start")
async def voice_start() -> dict[str, str]:
    """Start push-to-talk capture when the optional voice listener is enabled."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.begin_capture()
    return {"status": "capturing"}


@app.post("/voice/stop")
async def voice_stop() -> dict[str, str]:
    """Stop push-to-talk capture."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.end_capture()
    return {"status": "paused"}


@app.post("/voice/capture-once")
async def voice_capture_once() -> dict[str, str]:
    """Capture one voice chunk when the optional voice listener is enabled."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.capture_once()
    return {"status": "queued"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Text-based WebSocket command channel; voice streaming can be added later."""
    await websocket.accept()
    try:
        while True:
            text = await websocket.receive_text()
            result = await process_text_command(app, text, "user")
            await websocket.send_json({"reply": result.reply, "speaker": result.speaker})
    except WebSocketDisconnect:
        return


def run() -> None:
    """Run the unified API with uvicorn."""
    import uvicorn

    configure_logging()
    settings = Settings.from_env()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()

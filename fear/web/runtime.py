from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from fear.audio.natural_tts import NaturalTTS
from fear.audio.voice_listener import TranscriptEvent, VoiceListener
from fear.brain.async_conversation import AsyncConversationalBrain
from fear.config import Settings
from fear.input.clap_detector import ClapDetector
from fear.input.wearable_taps import GestureName, WearableTapEvent, gesture_to_command
from fear.library.reference_library import ReferenceLibrary
from fear.memory.obsidian_watcher import ObsidianWatcher
from fear.memory.personal_memory import PersonalMemory


class CommandRequest(BaseModel):
    """Request body for /command."""

    text: str
    speaker: str = "user"
    speak: bool = True


class CommandResponse(BaseModel):
    """Response body for /command."""

    reply: str
    speaker: str
    audio_file: Optional[str] = None


class MemoryResponse(BaseModel):
    """Response body for /memory/{speaker}."""

    speaker: str
    memories: list[dict[str, object]]


class TapGesturePayload(BaseModel):
    """Request body for /wearable/tap."""

    gesture: GestureName = "single_tap"
    device_id: Optional[str] = None
    speaker: str = "user"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize and stop the unified F.E.A.R. runtime."""
    settings = Settings.from_env()
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
    tts = NaturalTTS()
    brain = AsyncConversationalBrain(
        settings=settings,
        memory=memory,
        reference_library=reference_library,
    )

    app.state.settings = settings
    app.state.memory = memory
    app.state.reference_library = reference_library
    app.state.tts = tts
    app.state.brain = brain
    app.state.loop = asyncio.get_running_loop()
    app.state.voice_listener = None
    app.state.obsidian_watcher = None
    app.state.clap_detector = None

    obsidian_path = os.getenv("OBSIDIAN_VAULT_PATH", "").strip()
    if obsidian_path:
        watcher = ObsidianWatcher(
            vault_path=obsidian_path,
            memory=memory,
            speaker=os.getenv("OBSIDIAN_SPEAKER", "fear_user"),
        )
        watcher.start()
        app.state.obsidian_watcher = watcher

    if _env_bool("FEAR_ENABLE_VOICE_LISTENER", default=False):
        def on_transcript(event: TranscriptEvent) -> None:
            loop = app.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(_process_voice_event(app, event))
            )

        voice_listener = VoiceListener(
            on_transcript=on_transcript,
            model_name=settings.whisper_model_name,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        voice_listener.start()
        app.state.voice_listener = voice_listener

    if _env_bool("FEAR_ENABLE_CLAP_DETECTOR", default=False):
        def on_double_clap() -> None:
            loop = app.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(
                    _process_text_command(app, "toggle Spotify playback", "clap")
                )
            )

        clap_detector = ClapDetector(
            on_double_clap=on_double_clap,
            threshold=settings.clap_threshold,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        clap_detector.start()
        app.state.clap_detector = clap_detector

    try:
        yield
    finally:
        voice_listener = getattr(app.state, "voice_listener", None)
        if voice_listener is not None:
            voice_listener.stop()

        obsidian_watcher = getattr(app.state, "obsidian_watcher", None)
        if obsidian_watcher is not None:
            obsidian_watcher.stop()

        clap_detector = getattr(app.state, "clap_detector", None)
        if clap_detector is not None:
            clap_detector.stop()


app = FastAPI(title="F.E.A.R. Unified API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
_mount_static_frontend(app)


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check."""
    settings = getattr(app.state, "settings", None)
    assistant_name = settings.assistant_name if settings else "F.E.A.R."
    return {"status": "ok", "assistant": assistant_name}


@app.post("/command", response_model=CommandResponse)
async def command(payload: CommandRequest) -> CommandResponse:
    """Process a text command and optionally speak it locally."""
    result = await _process_text_command(app, payload.text, payload.speaker)

    if payload.speak and result.reply:
        audio_path = await app.state.tts.say(result.reply)
        if audio_path is not None:
            try:
                audio_path.unlink(missing_ok=True)
            except OSError:
                pass

    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.get("/memory/{speaker}", response_model=MemoryResponse)
async def memory_for_speaker(speaker: str) -> MemoryResponse:
    """Return recent memories for a speaker."""
    memories = await asyncio.to_thread(app.state.memory.get_facts_about_speaker, speaker)
    return MemoryResponse(
        speaker=speaker,
        memories=[
            {"text": item.text, "source": item.source, "timestamp": item.timestamp}
            for item in memories
        ],
    )


@app.post("/wearable/tap", response_model=CommandResponse)
async def wearable_tap(payload: TapGesturePayload) -> CommandResponse:
    """Process a simple wearable tap as a command."""
    text = gesture_to_command(WearableTapEvent(payload.gesture, payload.device_id))
    result = await _process_text_command(app, text or payload.gesture, payload.speaker)
    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


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
            result = await _process_text_command(app, text, "user")
            await websocket.send_json({"reply": result.reply, "speaker": result.speaker})
    except WebSocketDisconnect:
        return


async def _process_text_command(app: FastAPI, text: str, speaker: str):
    return await app.state.brain.process_command(text, speaker)


async def _process_voice_event(app: FastAPI, event: TranscriptEvent) -> None:
    result = await _process_text_command(app, event.message, event.speaker)
    if result.reply:
        await app.state.tts.say(result.reply)


def _cors_origins() -> list[str]:
    raw = os.getenv(
        "FEAR_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _mount_static_frontend(app: FastAPI) -> None:
    frontend_path = Path(__file__).resolve().parents[2] / "frontend"
    if frontend_path.exists():
        app.mount("/legacy", StaticFiles(directory=str(frontend_path), html=True), name="legacy")


def _env_bool(name: str, *, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def run() -> None:
    settings = Settings.from_env()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()

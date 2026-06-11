from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from fear.audio.natural_tts import NaturalTTS
from fear.audio.voice_listener import TranscriptEvent, VoiceListener
from fear.brain.conversation import ConversationalBrain
from fear.config import Settings
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


app = FastAPI(title="F.E.A.R. Unified API")


@app.on_event("startup")
async def startup() -> None:
    """Initialize the advanced F.E.A.R. runtime."""
    settings = Settings.from_env()
    memory = PersonalMemory(
        path=settings.chroma_path,
        collection_name="personal_memory",
    )

    reference_library = ReferenceLibrary(
        path=settings.chroma_path,
        collection_name=os.getenv("BOOK_KNOWLEDGE_COLLECTION", "book_knowledge"),
    )

    tts = NaturalTTS()
    brain = ConversationalBrain(
        settings=settings,
        memory=memory,
        reference_library=reference_library,
    )

    app.state.settings = settings
    app.state.memory = memory
    app.state.reference_library = reference_library
    app.state.tts = tts
    app.state.brain = brain
    app.state.background_threads = []

    obsidian_path = os.getenv("OBSIDIAN_VAULT_PATH", "").strip()
    if obsidian_path:
        watcher = ObsidianWatcher(
            vault_path=obsidian_path,
            memory=memory,
            speaker=os.getenv("OBSIDIAN_SPEAKER", "fear_user"),
        )
        watcher.start()
        app.state.obsidian_watcher = watcher
    else:
        app.state.obsidian_watcher = None

    def on_transcript(event: TranscriptEvent) -> None:
        """Bridge VoiceListener thread events into the FastAPI event loop."""
        loop = app.state.loop
        loop.call_soon_threadsafe(
            lambda: asyncio.create_task(_process_voice_event(event))
        )

    app.state.loop = asyncio.get_running_loop()
    voice_listener = VoiceListener(
        on_transcript=on_transcript,
        model_name=settings.whisper_model_name,
        sample_rate=settings.sample_rate,
        chunk_size=settings.chunk_size,
    )
    voice_listener.start()
    app.state.voice_listener = voice_listener


@app.on_event("shutdown")
async def shutdown() -> None:
    """Stop background threads cleanly."""
    voice_listener = getattr(app.state, "voice_listener", None)
    if voice_listener is not None:
        voice_listener.stop()

    obsidian_watcher = getattr(app.state, "obsidian_watcher", None)
    if obsidian_watcher is not None:
        obsidian_watcher.stop()


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check."""
    return {"status": "ok", "assistant": "F.E.A.R."}


@app.post("/command", response_model=CommandResponse)
async def command(payload: CommandRequest) -> CommandResponse:
    """Process a text command and optionally synthesize the reply."""
    result = await app.state.brain.process_command(payload.text, payload.speaker)
    audio_file: Optional[str] = None

    if payload.speak and result.reply:
        audio_path = await app.state.tts.say(result.reply)
        audio_file = str(audio_path) if audio_path else None

    return CommandResponse(
        reply=result.reply,
        speaker=result.speaker,
        audio_file=audio_file,
    )


@app.get("/memory/{speaker}", response_model=MemoryResponse)
async def memory_for_speaker(speaker: str) -> MemoryResponse:
    """Return recent memories for a speaker."""
    memories = app.state.memory.get_facts_about_speaker(speaker)

    return MemoryResponse(
        speaker=speaker,
        memories=[
            {
                "text": item.text,
                "source": item.source,
                "timestamp": item.timestamp,
            }
            for item in memories
        ],
    )


@app.post("/voice/start")
async def voice_start() -> dict[str, str]:
    """Start push-to-talk style capture."""
    app.state.voice_listener.begin_capture()
    return {"status": "capturing"}


@app.post("/voice/stop")
async def voice_stop() -> dict[str, str]:
    """Stop push-to-talk style capture."""
    app.state.voice_listener.end_capture()
    return {"status": "paused"}


@app.post("/voice/capture-once")
async def voice_capture_once() -> dict[str, str]:
    """Capture one 5-second voice chunk in the background."""
    app.state.voice_listener.capture_once()
    return {"status": "queued"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """
    Placeholder WebSocket for future real-time voice streaming.

    For now, it accepts text messages and returns command replies.
    """
    await websocket.accept()

    try:
        while True:
            text = await websocket.receive_text()
            result = await app.state.brain.process_command(text, "user")
            await websocket.send_json(
                {
                    "reply": result.reply,
                    "speaker": result.speaker,
                }
            )
    except WebSocketDisconnect:
        return


async def _process_voice_event(event: TranscriptEvent) -> None:
    """Process a transcript produced by the background VoiceListener."""
    result = await app.state.brain.process_command(event.message, event.speaker)
    if result.reply:
        await app.state.tts.say(result.reply)


def run() -> None:
    """Run the unified API with uvicorn."""
    settings = Settings.from_env()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()

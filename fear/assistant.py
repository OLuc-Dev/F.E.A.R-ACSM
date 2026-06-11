from __future__ import annotations

import asyncio
import os
import tempfile
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

import chromadb
import pyaudio
import pyttsx3
import spotipy
import uvicorn
import whisper
from fastapi import FastAPI
from openai import AsyncOpenAI
from pydantic import BaseModel
from spotipy.oauth2 import SpotifyOAuth

from fear.config import Settings
from fear.input.clap_detector import ClapDetector


AssistantSource = Literal["voice", "wearable", "web", "clap", "system"]
GestureName = Literal["single_tap", "double_tap", "long_press", "double_clap"]


@dataclass(slots=True)
class CommandEvent:
    """A normalized command from voice, web, wearable gestures, or claps."""

    text: str
    source: AssistantSource
    metadata: dict[str, Any] = field(default_factory=dict)


app = FastAPI(title="F.E.A.R. Desktop Assistant")


class TextCommandPayload(BaseModel):
    text: str


class TapGesturePayload(BaseModel):
    gesture: GestureName = "single_tap"
    device_id: Optional[str] = None


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check for the local web interface."""
    return {"status": "ok", "assistant": "F.E.A.R."}


@app.post("/command")
async def submit_text_command(payload: TextCommandPayload) -> dict[str, str]:
    """Queue a text command through the local HTTP interface."""
    assistant: FearAssistant = app.state.assistant

    await assistant.command_queue.put(
        CommandEvent(
            text=payload.text,
            source="web",
            metadata={"transport": "fastapi"},
        )
    )

    return {"status": "queued"}


@app.post("/wearable/tap")
async def submit_wearable_tap(payload: TapGesturePayload) -> dict[str, str]:
    """Queue a simple tap gesture from a wearable bridge."""
    assistant: FearAssistant = app.state.assistant
    await assistant.gesture_queue.put(payload.gesture)
    return {"status": "queued", "gesture": payload.gesture}


@app.post("/shutdown")
async def shutdown_assistant() -> dict[str, str]:
    """Ask the desktop assistant to shut down."""
    assistant: FearAssistant = app.state.assistant
    assistant.shutdown_event.set()
    return {"status": "shutting_down"}


class FearAssistant:
    """
    Main orchestrator for F.E.A.R.

    This skeleton keeps the first version readable. As the assistant grows,
    move wake-word, memory, Spotify, and web code into their package modules.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

        self.command_queue: asyncio.Queue[CommandEvent] = asyncio.Queue()
        self.gesture_queue: asyncio.Queue[GestureName] = asyncio.Queue()
        self.shutdown_event = asyncio.Event()

        self.loop: Optional[asyncio.AbstractEventLoop] = None

        # OpenRouter uses an OpenAI-compatible API surface, so the openai
        # package is still useful even when models are provided by OpenRouter.
        self.llm_client: Optional[AsyncOpenAI] = None

        self.whisper_model: Any = None
        self.tts_engine: Any = None
        self.chroma_collection: Any = None
        self.spotify: Optional[spotipy.Spotify] = None
        self.clap_detector: Optional[ClapDetector] = None

        self._tts_lock = asyncio.Lock()

    async def start(self) -> None:
        """Initialize services and run background loops until shutdown."""
        self.loop = asyncio.get_running_loop()

        await self.initialize_services()
        app.state.assistant = self

        self.clap_detector = ClapDetector(
            on_double_clap=self._on_double_clap_from_thread,
            threshold=self.settings.clap_threshold,
            sample_rate=self.settings.sample_rate,
            chunk_size=self.settings.chunk_size,
        )
        self.clap_detector.start()

        tasks = [
            asyncio.create_task(self.wake_word_loop(), name="wake-word-loop"),
            asyncio.create_task(self.command_processor_loop(), name="command-processor-loop"),
            asyncio.create_task(self.gesture_processor_loop(), name="gesture-processor-loop"),
            asyncio.create_task(self.web_server_loop(), name="web-server-loop"),
        ]

        try:
            await self.speak(f"{self.settings.assistant_name} online.")
            await self.shutdown_event.wait()
        finally:
            if self.clap_detector is not None:
                self.clap_detector.stop()

            for task in tasks:
                task.cancel()

            await asyncio.gather(*tasks, return_exceptions=True)
            await self.speak(f"{self.settings.assistant_name} shutting down.")

    async def initialize_services(self) -> None:
        """Initialize local and external services."""
        if self.settings.openrouter_api_key:
            self.llm_client = AsyncOpenAI(
                api_key=self.settings.openrouter_api_key,
                base_url=self.settings.openrouter_base_url,
                default_headers={
                    "HTTP-Referer": self.settings.openrouter_http_referer,
                    "X-Title": self.settings.openrouter_app_title,
                },
            )

        self.whisper_model = await asyncio.to_thread(
            whisper.load_model,
            self.settings.whisper_model_name,
        )

        self.tts_engine = pyttsx3.init()

        chroma_client = chromadb.PersistentClient(path=self.settings.chroma_path)
        self.chroma_collection = chroma_client.get_or_create_collection(
            name=self.settings.chroma_collection_name,
        )

        if os.getenv("SPOTIPY_CLIENT_ID") and os.getenv("SPOTIPY_CLIENT_SECRET"):
            self.spotify = spotipy.Spotify(
                auth_manager=SpotifyOAuth(scope=self.settings.spotify_scope)
            )

    async def wake_word_loop(self) -> None:
        """
        Continuously listen for wake words.

        This first skeleton uses Whisper on short audio windows. Later, replace
        this with a lightweight wake-word engine to reduce CPU use.
        """
        while not self.shutdown_event.is_set():
            try:
                if await self.detect_wake_word():
                    await self.speak("Listening.")

                    command_audio_path = await asyncio.to_thread(
                        self.record_wav_file,
                        4.0,
                    )
                    command_text = await self.transcribe_audio(command_audio_path)

                    if command_text:
                        await self.command_queue.put(
                            CommandEvent(
                                text=command_text,
                                source="voice",
                                metadata={"wake_word_detected": True},
                            )
                        )

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[wake_word_loop] Error: {exc}")

            await asyncio.sleep(0.05)

    async def detect_wake_word(self) -> bool:
        """Record a short audio window and check for a configured wake word."""
        audio_path = await asyncio.to_thread(self.record_wav_file, 1.5)
        text = await self.transcribe_audio(audio_path)
        normalized = text.lower().strip()
        return any(wake_word in normalized for wake_word in self.settings.wake_words)

    def record_wav_file(self, seconds: float) -> Path:
        """Blocking microphone recording helper called via asyncio.to_thread."""
        pa = pyaudio.PyAudio()
        stream = None

        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.settings.sample_rate,
                input=True,
                frames_per_buffer=self.settings.chunk_size,
            )

            frame_count = int(
                self.settings.sample_rate / self.settings.chunk_size * seconds
            )
            frames: list[bytes] = []

            for _ in range(frame_count):
                frames.append(
                    stream.read(
                        self.settings.chunk_size,
                        exception_on_overflow=False,
                    )
                )

            _, raw_path = tempfile.mkstemp(prefix="fear_audio_", suffix=".wav")
            output_path = Path(raw_path)

            with wave.open(str(output_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(pa.get_sample_size(pyaudio.paInt16))
                wav_file.setframerate(self.settings.sample_rate)
                wav_file.writeframes(b"".join(frames))

            return output_path

        finally:
            if stream is not None:
                stream.stop_stream()
                stream.close()
            pa.terminate()

    async def transcribe_audio(self, audio_path: Path) -> str:
        """Transcribe a WAV file with local Whisper."""
        try:
            result = await asyncio.to_thread(
                self.whisper_model.transcribe,
                str(audio_path),
            )
            return str(result.get("text", "")).strip()
        finally:
            try:
                audio_path.unlink(missing_ok=True)
            except Exception:
                pass

    async def command_processor_loop(self) -> None:
        """Consume normalized commands and execute them."""
        while not self.shutdown_event.is_set():
            try:
                event = await self.command_queue.get()

                try:
                    response = await self.handle_command(event)
                    if response:
                        await self.speak(response)
                finally:
                    self.command_queue.task_done()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[command_processor_loop] Error: {exc}")

    async def handle_command(self, event: CommandEvent) -> str:
        """Basic command router."""
        text = event.text.strip()
        lower = text.lower()

        if not text:
            return ""

        if event.source in {"wearable", "clap"}:
            return await self.handle_gesture_command(event)

        if "spotify" in lower or "music" in lower or "song" in lower:
            spotify_response = await self.handle_spotify_intent(lower)
            if spotify_response:
                return spotify_response

        if lower.startswith("remember "):
            memory_text = text.removeprefix("remember ").strip()
            await self.remember(memory_text)
            return "I will remember that."

        memory_context = await self.search_memory(text)
        answer = await self.ask_llm(text, memory_context)

        if answer:
            await self.remember(f"User: {text}\nAssistant: {answer}")

        return answer

    async def ask_llm(self, user_text: str, memory_context: str) -> str:
        """Ask OpenRouter using the OpenAI-compatible Python client."""
        if self.llm_client is None:
            return "OpenRouter is not configured. Set OPENROUTER_API_KEY."

        if not self.settings.openrouter_chat_model:
            return "Set OPENROUTER_CHAT_MODEL before using AI responses."

        system_prompt = (
            "You are F.E.A.R., a desktop AI assistant. "
            "Be concise, helpful, and action-oriented."
        )

        if memory_context:
            system_prompt += f"\n\nRelevant memory:\n{memory_context}"

        response = await self.llm_client.chat.completions.create(
            model=self.settings.openrouter_chat_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
        )

        return response.choices[0].message.content or ""

    async def speak(self, text: str) -> None:
        """Speak text through pyttsx3 without blocking the event loop."""
        if not text or self.tts_engine is None:
            return

        async with self._tts_lock:
            await asyncio.to_thread(self._speak_blocking, text)

    def _speak_blocking(self, text: str) -> None:
        self.tts_engine.say(text)
        self.tts_engine.runAndWait()

    async def embed_text(self, text: str) -> Optional[list[float]]:
        """Create an embedding through OpenRouter when configured."""
        if self.llm_client is None:
            return None

        if not self.settings.openrouter_embedding_model:
            return None

        response = await self.llm_client.embeddings.create(
            model=self.settings.openrouter_embedding_model,
            input=text,
        )

        return response.data[0].embedding

    async def remember(self, text: str) -> None:
        """Store text in ChromaDB when embeddings are configured."""
        if not text or self.chroma_collection is None:
            return

        embedding = await self.embed_text(text)
        if embedding is None:
            return

        memory_id = f"memory-{time.time_ns()}"

        await asyncio.to_thread(
            self.chroma_collection.add,
            ids=[memory_id],
            documents=[text],
            embeddings=[embedding],
            metadatas=[{"created_at": time.time()}],
        )

    async def search_memory(self, query: str, n_results: int = 3) -> str:
        """Search ChromaDB memories when embeddings are configured."""
        if self.chroma_collection is None:
            return ""

        embedding = await self.embed_text(query)
        if embedding is None:
            return ""

        results = await asyncio.to_thread(
            self.chroma_collection.query,
            query_embeddings=[embedding],
            n_results=n_results,
        )

        documents = results.get("documents", [[]])
        if not documents or not documents[0]:
            return ""

        return "\n".join(str(doc) for doc in documents[0])

    async def handle_spotify_intent(self, lower_text: str) -> str:
        """Handle very simple Spotify playback commands."""
        if self.spotify is None:
            return "Spotify is not configured."

        try:
            if "pause" in lower_text:
                await asyncio.to_thread(self.spotify.pause_playback)
                return "Paused Spotify."

            if "resume" in lower_text or "play" in lower_text:
                await asyncio.to_thread(self.spotify.start_playback)
                return "Resumed Spotify."

            if "next" in lower_text or "skip" in lower_text:
                await asyncio.to_thread(self.spotify.next_track)
                return "Skipped to the next track."

            if "previous" in lower_text or "back" in lower_text:
                await asyncio.to_thread(self.spotify.previous_track)
                return "Went back to the previous track."

        except Exception as exc:
            return f"Spotify command failed: {exc}"

        return ""

    async def gesture_processor_loop(self) -> None:
        """Process wearable taps and double-clap gestures."""
        while not self.shutdown_event.is_set():
            try:
                gesture = await self.gesture_queue.get()

                try:
                    if gesture == "single_tap":
                        await self.command_queue.put(
                            CommandEvent(
                                text="toggle Spotify playback",
                                source="wearable",
                                metadata={"gesture": gesture},
                            )
                        )

                    elif gesture == "double_tap":
                        await self.command_queue.put(
                            CommandEvent(
                                text="next Spotify song",
                                source="wearable",
                                metadata={"gesture": gesture},
                            )
                        )

                    elif gesture == "long_press":
                        await self.speak("Long press detected. Listening.")
                        audio_path = await asyncio.to_thread(self.record_wav_file, 4.0)
                        command_text = await self.transcribe_audio(audio_path)

                        if command_text:
                            await self.command_queue.put(
                                CommandEvent(
                                    text=command_text,
                                    source="wearable",
                                    metadata={"gesture": gesture},
                                )
                            )

                    elif gesture == "double_clap":
                        await self.command_queue.put(
                            CommandEvent(
                                text="toggle Spotify playback",
                                source="clap",
                                metadata={"gesture": gesture},
                            )
                        )

                finally:
                    self.gesture_queue.task_done()

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[gesture_processor_loop] Error: {exc}")

    async def handle_gesture_command(self, event: CommandEvent) -> str:
        """Convert gesture commands into concrete actions."""
        lower = event.text.lower()

        if "spotify" in lower:
            if "next" in lower:
                return await self.handle_spotify_intent("next song")

            if "pause" in lower or "resume" in lower or "toggle" in lower:
                if self.spotify is None:
                    return "Spotify is not configured."

                try:
                    playback = await asyncio.to_thread(self.spotify.current_playback)

                    if playback and playback.get("is_playing"):
                        await asyncio.to_thread(self.spotify.pause_playback)
                        return "Paused Spotify."

                    await asyncio.to_thread(self.spotify.start_playback)
                    return "Resumed Spotify."

                except Exception as exc:
                    return f"Spotify toggle failed: {exc}"

        return "Gesture received."

    def _on_double_clap_from_thread(self) -> None:
        """Bridge ClapDetector's thread callback into the asyncio loop."""
        if self.loop is None:
            return

        self.loop.call_soon_threadsafe(
            self.gesture_queue.put_nowait,
            "double_clap",
        )

    async def web_server_loop(self) -> None:
        """Run FastAPI in the same asyncio process."""
        config = uvicorn.Config(
            app,
            host=self.settings.host,
            port=self.settings.port,
            log_level="info",
        )
        server = uvicorn.Server(config)
        await server.serve()

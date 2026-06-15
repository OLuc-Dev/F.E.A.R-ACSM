from __future__ import annotations

import logging
import queue
import re
import tempfile
import threading
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pyaudio
import whisper


@dataclass(slots=True)
class TranscriptEvent:
    """A transcript event produced by VoiceListener."""

    raw_text: str
    speaker: str
    message: str
    audio_path: Path | None = None


class VoiceListener:
    """
    Threaded microphone listener that records fixed audio chunks and transcribes them.

    External input code can call begin_capture() and end_capture() from a keyboard
    hook, wearable action, or wake-word detector.
    """

    SPEAKER_PREFIX_RE = re.compile(r"^\s*([A-Za-z0-9 ._-]{1,40})\s*:\s*(.+)$")

    def __init__(
        self,
        *,
        on_transcript: Callable[[TranscriptEvent], None] | None = None,
        model_name: str = "base",
        sample_rate: int = 16_000,
        chunk_size: int = 1_024,
        record_seconds: float = 5.0,
        default_speaker: str = "user",
        input_device_index: int | None = None,
    ) -> None:
        self.on_transcript = on_transcript
        self.model_name = model_name
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        self.record_seconds = record_seconds
        self.default_speaker = default_speaker
        self.input_device_index = input_device_index

        self._stop_event = threading.Event()
        self._capture_event = threading.Event()
        self._audio_queue: queue.Queue[Path] = queue.Queue()

        self._recorder_thread: threading.Thread | None = None
        self._transcriber_thread: threading.Thread | None = None
        self._model = None
        self._lock = threading.Lock()
        self._logger = logging.getLogger(self.__class__.__name__)

    @property
    def is_running(self) -> bool:
        """Return True when the recorder thread is alive."""
        return self._recorder_thread is not None and self._recorder_thread.is_alive()

    def start(self) -> None:
        """Start background recorder and transcriber threads."""
        with self._lock:
            if self.is_running:
                return

            self._stop_event.clear()
            self._capture_event.clear()

            self._recorder_thread = threading.Thread(
                target=self._recording_loop,
                name="VoiceListenerRecorderThread",
                daemon=True,
            )
            self._transcriber_thread = threading.Thread(
                target=self._transcription_loop,
                name="VoiceListenerTranscriberThread",
                daemon=True,
            )

            self._recorder_thread.start()
            self._transcriber_thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """Stop the listener and wait briefly for background threads."""
        with self._lock:
            self._stop_event.set()
            self._capture_event.clear()
            current = threading.current_thread()

            if self._recorder_thread and self._recorder_thread is not current:
                self._recorder_thread.join(timeout=timeout)
            if self._transcriber_thread and self._transcriber_thread is not current:
                self._transcriber_thread.join(timeout=timeout)

            self._recorder_thread = None
            self._transcriber_thread = None

    def begin_capture(self) -> None:
        """Enable audio capture."""
        self._capture_event.set()

    def end_capture(self) -> None:
        """Pause audio capture."""
        self._capture_event.clear()

    def capture_once(self) -> None:
        """Record one chunk and queue it for transcription."""
        try:
            self._audio_queue.put(self._record_wav_file(self.record_seconds))
        except Exception:
            self._logger.exception("Failed to capture one voice chunk")

    def _recording_loop(self) -> None:
        """Record chunks while capture is enabled."""
        while not self._stop_event.is_set():
            if not self._capture_event.wait(timeout=0.1):
                continue

            try:
                self._audio_queue.put(self._record_wav_file(self.record_seconds))
            except Exception:
                self._logger.exception("Voice recording chunk failed")

    def _transcription_loop(self) -> None:
        """Transcribe queued audio files with local Whisper."""
        try:
            self._model = whisper.load_model(self.model_name)
        except Exception:
            self._logger.exception("Failed to load Whisper model")
            return

        while not self._stop_event.is_set():
            try:
                audio_path = self._audio_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            try:
                event = self._transcribe_file(audio_path)
                if event and self.on_transcript is not None:
                    self.on_transcript(event)
            except Exception:
                self._logger.exception("Voice transcription failed")
            finally:
                self._audio_queue.task_done()
                try:
                    audio_path.unlink(missing_ok=True)
                except Exception:
                    pass

    def _transcribe_file(self, audio_path: Path) -> TranscriptEvent | None:
        """Transcribe one file and parse an optional speaker prefix."""
        if self._model is None:
            return None

        result = self._model.transcribe(str(audio_path))
        raw_text = str(result.get("text", "")).strip()

        if not raw_text:
            return None

        speaker, message = self.extract_speaker(raw_text, self.default_speaker)
        return TranscriptEvent(raw_text=raw_text, speaker=speaker, message=message, audio_path=audio_path)

    @classmethod
    def extract_speaker(cls, text: str, default_speaker: str = "user") -> tuple[str, str]:
        """Extract a speaker from text formatted as 'Name: message'."""
        match = cls.SPEAKER_PREFIX_RE.match(text)
        if not match:
            return default_speaker, text.strip()

        return match.group(1).strip() or default_speaker, match.group(2).strip()

    def _record_wav_file(self, seconds: float) -> Path:
        """Record mono 16-bit PCM audio to a temporary WAV file."""
        pa = pyaudio.PyAudio()
        stream = None

        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                input_device_index=self.input_device_index,
            )

            frame_count = int(self.sample_rate / self.chunk_size * seconds)
            frames: list[bytes] = []

            for _ in range(frame_count):
                if self._stop_event.is_set():
                    break
                frames.append(stream.read(self.chunk_size, exception_on_overflow=False))

            _, raw_path = tempfile.mkstemp(prefix="fear_voice_", suffix=".wav")
            output_path = Path(raw_path)

            with wave.open(str(output_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(pa.get_sample_size(pyaudio.paInt16))
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(b"".join(frames))

            return output_path

        finally:
            if stream is not None:
                stream.stop_stream()
                stream.close()
            pa.terminate()

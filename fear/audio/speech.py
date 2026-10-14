"""Local speech for F.E.A.R.: Whisper hears you, Piper answers in its own voice.

Both run on this machine's CPU, so no audio ever leaves it. Each engine loads
its model once — ahead of time with ``preload`` (the app does it at start, in
the background) or on first use — and serializes its calls, so request threads
can share one instance. Both are optional: without their packages or model
files they report themselves unavailable, and the app falls back to typing and
to the browser's voice.
"""

from __future__ import annotations

import importlib.util
import io
import logging
import os
import threading
import wave
from pathlib import Path
from typing import Any, Literal

import numpy as np

logger = logging.getLogger(__name__)

VoiceStyle = Literal["fear", "natural"]

WHISPER_RATE = 16_000
# Lines Whisper is known to "hear" in noise, learned from subtitled videos.
_ARTIFACTS = (
    "legendas pela comunidade amara.org",
    "legenda adriana zanotto",
    "inscreva-se no canal",
    "obrigado por assistir",
)
# F.E.A.R.'s voice: 10% lower, a short comb (the metallic edge) and a slight
# 60 Hz ring. Checked by round trip — Whisper still understands it as well as
# the plain voice.
FEAR_PITCH = 0.9
_COMB_DELAY_S = 0.0032
_COMB_GAIN = 0.4
_RING_HZ = 60.0
_RING_DEPTH = 0.15
_PEAK = 0.89


def _is_artifact(text: str) -> bool:
    lowered = text.lower().strip(" .!")
    return any(artifact in lowered for artifact in _ARTIFACTS)


def _wait_without_spinning() -> None:
    # Between steps, CTranslate2's OpenMP threads busy-wait by default (libgomp
    # spins; Intel's OpenMP, used on Windows, for 200 ms). Alone on the CPU
    # that's a bit faster, but next to anything else busy — this app's own
    # window, a game, a call — the spinning threads crowd out the one doing the
    # work: measured here, a 3 s transcription took 20 s. Sleeping instead costs
    # about half a second at worst. Only read when CTranslate2 loads, so this
    # must run first; an explicit OMP_WAIT_POLICY wins.
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")


class SpeechToText:
    """Transcribes speech with faster-whisper (CTranslate2, int8 on the CPU)."""

    def __init__(self, model: str, *, language: str = "pt", cpu_threads: int = 0) -> None:
        self.model_ref = model
        self.language = language
        # CTranslate2's own default: more threads gain little on Whisper small
        # and leave less room for everything else running.
        self.cpu_threads = cpu_threads or min(4, os.cpu_count() or 4)
        self._model: Any = None
        self._lock = threading.Lock()
        _wait_without_spinning()

    @property
    def available(self) -> bool:
        if not self.model_ref or importlib.util.find_spec("faster_whisper") is None:
            return False
        # A path (the app's bundled model) must exist; a bare name like "small"
        # is fetched from Hugging Face on first use (development setups).
        if any(separator in self.model_ref for separator in ("/", "\\")):
            return Path(self.model_ref).expanduser().is_dir()
        return True

    def preload(self) -> None:
        # The very first pass also allocates buffers; doing it now keeps the
        # first real command quick.
        self._transcribe(np.zeros(WHISPER_RATE, dtype=np.float32))

    def transcribe(self, audio: bytes) -> str:
        """What was said in `audio` (webm/opus, wav, ogg… anything PyAV reads), or ""."""
        from faster_whisper import decode_audio

        samples = decode_audio(io.BytesIO(audio), sampling_rate=WHISPER_RATE)
        if samples.size < WHISPER_RATE // 10:
            return ""
        return self._transcribe(samples)

    def _transcribe(self, samples: np.ndarray) -> str:
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self._model = WhisperModel(
                    self.model_ref,
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=self.cpu_threads,
                )
            segments, _ = self._model.transcribe(
                samples,
                language=self.language,
                beam_size=5,
                # Drops silence and noise before decoding: no invented sentences.
                vad_filter=True,
                condition_on_previous_text=False,
            )
            texts = [segment.text.strip() for segment in segments if segment.no_speech_prob < 0.6]
        text = " ".join(part for part in texts if part).strip()
        return "" if _is_artifact(text) else text


def fear_voice(audio: np.ndarray, sample_rate: int, pitch: float = FEAR_PITCH) -> np.ndarray:
    """Give plain speech F.E.A.R.'s timbre: lower, with a cold metallic edge.

    The speech must come in already sped up by `pitch` (Piper's length_scale):
    stretching it back to its natural length is what lowers the pitch, so the
    voice drops without slowing down.
    """
    if audio.size == 0:
        return audio.astype(np.float32)
    length = int(round(audio.size / pitch))
    stretched = np.interp(
        np.linspace(0.0, audio.size - 1, length), np.arange(audio.size), audio
    ).astype(np.float32)
    delay = max(1, int(sample_rate * _COMB_DELAY_S))
    comb = stretched.copy()
    comb[delay:] += _COMB_GAIN * stretched[:-delay]
    t = np.arange(comb.size, dtype=np.float32) / sample_rate
    ring = (1.0 - _RING_DEPTH) + _RING_DEPTH * np.cos(2.0 * np.pi * _RING_HZ * t)
    voiced = comb * ring
    peak = float(np.max(np.abs(voiced)))
    return (voiced / peak * _PEAK).astype(np.float32) if peak > 0 else voiced


def encode_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    """Mono 16-bit PCM WAV bytes, which every browser plays."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class TextToSpeech:
    """Speaks with a Piper voice (ONNX), optionally in F.E.A.R.'s timbre."""

    def __init__(self, voice_path: str) -> None:
        self.voice_path = voice_path
        self._voice: Any = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        if not self.voice_path or importlib.util.find_spec("piper") is None:
            return False
        model = Path(self.voice_path).expanduser()
        return model.is_file() and Path(f"{model}.json").is_file()

    def preload(self) -> None:
        self.synthesize("Pronto.")

    def synthesize(self, text: str, style: VoiceStyle = "fear") -> bytes:
        """`text` spoken, as WAV bytes."""
        from piper import SynthesisConfig

        with self._lock:
            if self._voice is None:
                from piper import PiperVoice

                self._voice = PiperVoice.load(str(Path(self.voice_path).expanduser()))
            voice = self._voice
            pitch = FEAR_PITCH if style == "fear" else 1.0
            config = SynthesisConfig(length_scale=voice.config.length_scale * pitch)
            chunks = list(voice.synthesize(text, syn_config=config))
        sample_rate = chunks[0].sample_rate if chunks else voice.config.sample_rate
        audio = (
            np.concatenate([chunk.audio_float_array for chunk in chunks]).astype(np.float32)
            if chunks
            else np.zeros(0, dtype=np.float32)
        )
        if style == "fear":
            audio = fear_voice(audio, sample_rate)
        return encode_wav(audio, sample_rate)

"""Local speech: F.E.A.R.'s voice effect, WAV encoding, and the engines.

The round-trip tests (Piper speaks, Whisper listens) need the models; they run
when FEAR_TEST_PIPER_VOICE and FEAR_TEST_WHISPER_MODEL point at them, as on the
machine that builds the Windows app.
"""

from __future__ import annotations

import io
import os
import re
import unicodedata
import wave
from pathlib import Path

import numpy as np
import pytest

from fear.audio import speech
from fear.audio.speech import SpeechToText, TextToSpeech, encode_wav, fear_voice

# Exactly what the app's window uploads when you talk: Chromium's MediaRecorder
# (WebView2 is Chromium) recording Piper's voice asking "Qual é a capital da
# França?" through a microphone — 4.3 s of webm/opus with no duration in its
# header, as browsers write it.
BROWSER_RECORDING = Path(__file__).parent / "fixtures" / "browser-recording.webm"


def _dominant_hz(audio: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(audio * np.hanning(audio.size)))
    return float(np.fft.rfftfreq(audio.size, 1 / rate)[np.argmax(spectrum)])


def test_fear_voice_is_lower_but_as_long_as_natural_speech() -> None:
    rate = 22_050
    # Piper hands it speech already sped up by FEAR_PITCH: 1 s of speech
    # arrives as 0.9 s, and the effect stretches it back to ~1 s.
    t = np.arange(int(rate * speech.FEAR_PITCH)) / rate
    tone = (0.5 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)

    out = fear_voice(tone, rate)

    assert abs(out.size / rate - 1.0) < 0.01
    assert abs(_dominant_hz(out, rate) - 180) < 3  # 200 Hz -> 180 Hz: 10% lower
    assert np.all(np.isfinite(out)) and np.max(np.abs(out)) <= 0.9


def test_fear_voice_handles_silence_and_nothing() -> None:
    assert fear_voice(np.zeros(0, dtype=np.float32), 22_050).size == 0
    quiet = fear_voice(np.zeros(1000, dtype=np.float32), 22_050)
    assert np.all(quiet == 0)


def test_encode_wav_writes_playable_pcm() -> None:
    data = encode_wav(np.array([0.0, 0.5, -0.5, 1.5], dtype=np.float32), 22_050)
    with wave.open(io.BytesIO(data)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (
            1,
            2,
            22_050,
            4,
        )
        frames = np.frombuffer(wav.readframes(4), dtype="<i2")
    assert frames.tolist() == [0, 16383, -16383, 32767]  # 1.5 clipped, not wrapped


def test_subtitle_artifacts_are_not_messages() -> None:
    assert speech._is_artifact("Legendas pela comunidade Amara.org")
    assert not speech._is_artifact("Obrigado, F.E.A.R.")


def test_whisper_threads_sleep_instead_of_spinning(monkeypatch) -> None:
    # Spinning OpenMP threads made a 3 s transcription take 20 s whenever
    # anything else was using the CPU; the setting must be in place before
    # CTranslate2 loads, so creating the engine sets it.
    monkeypatch.delenv("OMP_WAIT_POLICY", raising=False)
    SpeechToText("small")
    assert os.environ["OMP_WAIT_POLICY"] == "PASSIVE"

    monkeypatch.setenv("OMP_WAIT_POLICY", "ACTIVE")  # someone who knows better
    SpeechToText("small")
    assert os.environ["OMP_WAIT_POLICY"] == "ACTIVE"


def test_reads_what_the_browser_records() -> None:
    faster_whisper = pytest.importorskip("faster_whisper")
    samples = faster_whisper.decode_audio(
        io.BytesIO(BROWSER_RECORDING.read_bytes()), sampling_rate=speech.WHISPER_RATE
    )
    assert 4.0 < samples.size / speech.WHISPER_RATE < 4.5
    assert np.max(np.abs(samples)) > 0.05  # the voice, not just the room


def test_engines_report_missing_models(tmp_path, monkeypatch) -> None:
    assert not SpeechToText(str(tmp_path / "no-model")).available
    assert not SpeechToText("").available
    assert not TextToSpeech(str(tmp_path / "voice.onnx")).available
    monkeypatch.setattr(speech.importlib.util, "find_spec", lambda name: None)
    assert not SpeechToText("small").available  # faster-whisper not installed


# --- the real thing ------------------------------------------------------------

PIPER = os.getenv("FEAR_TEST_PIPER_VOICE", "")
WHISPER = os.getenv("FEAR_TEST_WHISPER_MODEL", "")
needs_models = pytest.mark.skipif(
    not (PIPER and WHISPER), reason="set FEAR_TEST_PIPER_VOICE and FEAR_TEST_WHISPER_MODEL"
)


def _words(text: str) -> set[str]:
    plain = unicodedata.normalize("NFKD", text.lower())
    return set(re.findall(r"[a-z]+", "".join(c for c in plain if not unicodedata.combining(c))))


@pytest.fixture(scope="module")
def engines():
    return TextToSpeech(PIPER), SpeechToText(WHISPER)


@needs_models
@pytest.mark.parametrize("style", ["fear", "natural"])
def test_whisper_understands_what_piper_says(engines, style) -> None:
    voice, ears = engines
    # Piper's speech varies a little each time. These words came through in
    # 160 of 160 tries (both styles); "pausada" in 159, its p sometimes heard
    # as a c — the same in the plain voice, so not the effect's doing.
    wav = voice.synthesize("A música está pausada. Quer que eu continue depois?", style)
    heard = _words(ears.transcribe(wav))
    assert {"musica", "continue", "depois"} <= heard


@needs_models
def test_whisper_understands_a_browser_recording(engines) -> None:
    _, ears = engines
    heard = _words(ears.transcribe(BROWSER_RECORDING.read_bytes()))
    assert {"qual", "capital", "franca"} <= heard


@needs_models
def test_silence_is_not_transcribed_into_words(engines) -> None:
    _, ears = engines
    assert ears.transcribe(encode_wav(np.zeros(32_000, dtype=np.float32), 16_000)) == ""

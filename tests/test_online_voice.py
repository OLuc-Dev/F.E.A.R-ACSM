"""The online voice (Microsoft's neural voices through edge-tts), with a fake service.

No test here reaches the internet: the service is replaced by `connect`.
"""

from __future__ import annotations

import asyncio
import io
import wave
from collections.abc import AsyncIterator

import numpy as np
import pytest

from fear.audio import online_voice
from fear.audio.online_voice import OnlineVoice, OnlineVoiceError


class FakeService:
    """Answers like edge-tts: metadata and audio chunks, or a failure."""

    def __init__(self, audio: bytes = b"ID3fake-mp3", *, fail: Exception | None = None) -> None:
        self.audio = audio
        self.fail = fail
        self.asked: list[tuple[str, str]] = []
        self.delay = 0.0

    def __call__(self, text: str, rate: str) -> FakeService:
        self.asked.append((text, rate))
        return self

    async def stream(self) -> AsyncIterator[dict[str, object]]:
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise self.fail
        yield {"type": "SentenceBoundary", "offset": 0}
        half = len(self.audio) // 2
        for part in (self.audio[:half], self.audio[half:]):
            if part:
                yield {"type": "audio", "data": part}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def test_speaks_naturally_with_the_service_mp3_as_it_comes() -> None:
    service = FakeService(b"ID3" + b"x" * 100)
    voice = OnlineVoice(connect=service)

    audio, media_type = await voice.synthesize("Olá, Lucas.")

    assert (audio, media_type) == (b"ID3" + b"x" * 100, "audio/mpeg")
    assert service.asked == [("Olá, Lucas.", "+0%")]


def _mp3_tone(hz: float, seconds: float, rate: int = 24_000) -> bytes:
    """A real MP3 (PyAV's LAME encoder), as the service sends: mono, 24 kHz."""
    av = pytest.importorskip("av")
    out = io.BytesIO()
    with av.open(out, "w", format="mp3") as container:
        stream = container.add_stream("libmp3lame", rate=rate)
        stream.layout = "mono"
        t = np.arange(int(rate * seconds)) / rate
        samples = (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
        for start in range(0, samples.size, 1152):
            frame = av.AudioFrame.from_ndarray(
                samples[start : start + 1152].reshape(1, -1), format="flt", layout="mono"
            )
            frame.sample_rate = rate
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return out.getvalue()


async def test_fear_style_comes_out_lower_at_the_same_pace() -> None:
    pytest.importorskip("faster_whisper")
    # The service speaks 11% faster for this style: 1 s of speech arrives as 0.9 s.
    service = FakeService(_mp3_tone(200, 0.9))
    voice = OnlineVoice(connect=service)

    audio, media_type = await voice.synthesize("Olá.", "fear")

    assert media_type == "audio/wav"
    assert service.asked == [("Olá.", "+11%")]
    with wave.open(io.BytesIO(audio)) as wav:
        rate = wav.getframerate()
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32)
    assert rate == 24_000
    assert abs(pcm.size / rate - 1.0) < 0.08  # stretched back to ~1 s (MP3 adds padding)
    spectrum = np.abs(np.fft.rfft(pcm * np.hanning(pcm.size)))
    dominant = np.fft.rfftfreq(pcm.size, 1 / rate)[np.argmax(spectrum)]
    assert abs(dominant - 180) < 4  # 200 Hz -> 180 Hz: 10% lower


async def test_a_failure_rests_it_and_the_rest_grows_while_it_keeps_failing() -> None:
    clock = Clock()
    service = FakeService(fail=ConnectionError("no internet"))
    voice = OnlineVoice(connect=service, clock=clock)

    with pytest.raises(OnlineVoiceError, match="no internet"):
        await voice.synthesize("Oi.")
    assert not voice.ready()
    clock.now += 59
    assert not voice.ready()
    clock.now += 2
    assert voice.ready()  # a minute later it's worth trying again

    with pytest.raises(OnlineVoiceError):
        await voice.synthesize("Oi.")
    clock.now += 61
    assert not voice.ready()  # failing again: two minutes this time
    clock.now += 60
    assert voice.ready()

    service.fail = None  # back online: a success resets the rest
    await voice.synthesize("Oi.")
    service.fail = ConnectionError("gone again")
    with pytest.raises(OnlineVoiceError):
        await voice.synthesize("Oi.")
    clock.now += 61
    assert voice.ready()


async def test_no_audio_counts_as_a_failure() -> None:
    voice = OnlineVoice(connect=FakeService(b""), clock=Clock())
    with pytest.raises(OnlineVoiceError, match="no audio"):
        await voice.synthesize("Oi.")
    assert not voice.ready()


async def test_a_slow_service_gives_up_in_time() -> None:
    service = FakeService()
    service.delay = 1.0
    voice = OnlineVoice(connect=service, timeout=0.05, clock=Clock())
    with pytest.raises(OnlineVoiceError, match="Timeout"):
        await voice.synthesize("Oi.")
    assert not voice.ready()


def test_available_only_with_edge_tts_installed(monkeypatch) -> None:
    assert OnlineVoice(connect=FakeService()).available
    monkeypatch.setattr(online_voice.importlib.util, "find_spec", lambda name: None)
    voice = OnlineVoice()
    assert not voice.available and not voice.ready()


def test_trusts_this_computers_certificates_too() -> None:
    communicate = pytest.importorskip("edge_tts.communicate")
    online_voice._trust_this_computer.cache_clear()
    original = communicate._SSL_CTX
    try:
        online_voice._trust_this_computer()
        assert communicate._SSL_CTX is not original
        assert communicate._SSL_CTX.verify_mode.name == "CERT_REQUIRED"
    finally:
        communicate._SSL_CTX = original
        online_voice._trust_this_computer.cache_clear()


def test_uses_the_system_proxy(monkeypatch) -> None:
    monkeypatch.setattr(
        online_voice.urllib.request, "getproxies", lambda: {"https": "http://proxy:8080"}
    )
    assert online_voice._system_proxy() == "http://proxy:8080"
    monkeypatch.setattr(online_voice.urllib.request, "getproxies", lambda: {})
    assert online_voice._system_proxy() is None
